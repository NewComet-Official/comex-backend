// api/index.js

import admin from 'firebase-admin';
import Groq from 'groq-sdk';

function getDb() {
    if (!admin.apps.length) {
        const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
        if (!b64) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON env var.');
        const sa = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
        admin.initializeApp({ credential: admin.credential.cert(sa) });
    }
    return admin.firestore();
}

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export default async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();

    const path = req.url.split('?')[0].replace(/\/$/, '');

    if (path === '/api/chat')                     return handleChat(req, res);
    if (path === '/api/config')                   return handleConfig(req, res);
    if (path === '/api/scrape')                   return handleScrape(req, res);
    if (path === '/api/deploy')                   return handleDeploy(req, res);
    if (path === '/api/calculate-roi')            return handleROI(req, res);
    if (path === '/api/whatsapp-verify')          return handleWAVerify(req, res);
    if (path === '/api/whatsapp-verify-confirm')  return handleWAConfirm(req, res);
    if (path === '/api/oauth/google')             return handleGoogleOAuth(req, res);
    if (path === '/api/oauth/google/callback')    return handleGoogleCallback(req, res);

    // ── Trust & Safety / Moderation ──────────────────────────────────────
    if (path === '/api/auth-event')                return handleAuthEvent(req, res);
    if (path === '/api/moderation/status')         return handleModerationStatus(req, res);
    if (path === '/api/moderation/request-review') return handleRequestReview(req, res);
    if (path === '/api/moderation/delete-now')     return handleDeleteNow(req, res);
    if (path === '/api/moderation/acknowledge')    return handleAcknowledgeReinstatement(req, res);
    if (path === '/api/cron/daily-sweep')          return handleDailySweep(req, res);

    return res.status(404).json({ success: false, message: `Unknown route: ${path}` });
}

// ════════════════════════════════════════════════════════════════════════════
// DEPLOY
// ════════════════════════════════════════════════════════════════════════════
async function handleDeploy(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { botData, ownerEmail } = req.body || {};
    if (!botData?.id || !botData?.name || !ownerEmail)
        return res.status(400).json({ success: false, message: 'Missing botData.id, botData.name, or ownerEmail.' });
    try {
        botData.owner     = ownerEmail;
        botData.deletedAt = null;
        botData.createdAt = botData.createdAt || new Date().toISOString();
        const db = getDb();
        await db.collection('user_bots').doc(botData.id).set(botData, { merge: true });

        // ── Moderation: flag the owner's account if the bot name contains a
        //    listed bad word. Deploy still succeeds; the AI reviewer decides
        //    whether this alone (or combined with other signals) warrants
        //    disabling the account.
        try {
            const badWords = await getBadWordsSet();
            const match = textContainsBadWord(botData.name, badWords);
            if (match) {
                const signals = { bad_word_bot_name: { botName: botData.name, botId: botData.id } };
                await db.collection('users').doc(ownerEmail).set({ moderation: { signals } }, { merge: true });
                const decision = await aiEvaluateAccount(ownerEmail, signals);
                if (decision.action === 'disable') {
                    await applyModerationAction(ownerEmail, 'disable', decision.reason, db);
                }
            }
        } catch (modErr) {
            console.error('[Deploy/Moderation]', modErr.message);
        }

        return res.status(200).json({ success: true, botId: botData.id });
    } catch (err) {
        console.error('[Deploy]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// SCRAPE
// ════════════════════════════════════════════════════════════════════════════
async function handleScrape(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { businessId, url, customInstructions } = req.body || {};
    if (!businessId || !url)
        return res.status(400).json({ success: false, message: 'Missing businessId or url.' });
    try {
        const r = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 ComexAI/1.0' },
            signal: AbortSignal.timeout(12000)
        });
        if (!r.ok) throw new Error(`Fetch failed: HTTP ${r.status}`);
        const html = await r.text();
        const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 15000);
        if (text.length < 20) throw new Error('Could not extract text from this URL.');
        const update = { context: text };
        if (customInstructions) update['knowledgeContext.systemPrompt'] = customInstructions;
        await getDb().collection('user_bots').doc(businessId).set(update, { merge: true });
        return res.status(200).json({ success: true, message: `Scraped ${text.length} chars.`, snippet: text.substring(0, 200) });
    } catch (err) {
        console.error('[Scrape]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════════════════════
async function handleConfig(req, res) {
    const { businessId } = req.query;
    if (!businessId) return res.status(400).json({ success: false, error: 'Missing businessId.' });
    try {
        const snap = await getDb().collection('user_bots').doc(businessId).get();
        if (!snap.exists) return res.status(404).json({ success: false, error: 'Bot not found.' });
        const b = snap.data();
        return res.status(200).json({
            success:      true,
            name:         b.name                     || 'AI Assistant',
            position:     b.position                 || 'bottom-right',
            logoBase64:   b.logoBase64               || null,
            themeColor:   b.designConfig?.themeColor || '#0f172a',
            designConfig: b.designConfig             || {}
        });
    } catch (err) {
        console.error('[Config]', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// CHAT
// ════════════════════════════════════════════════════════════════════════════
async function handleChat(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { businessId, message, question, history = [], conversationId: inId } = req.body || {};
    const userMsg = message || question;

    if (!businessId || !userMsg)
        return res.status(400).json({ success: false, answer: 'Missing businessId or message.' });
    if (!process.env.GROQ_API_KEY)
        return res.status(500).json({ success: false, answer: 'GROQ_API_KEY not set.' });

    const convId = inId || `conv-${Date.now()}`;
    const db = getDb();

    try {
        const botSnap = await db.collection('user_bots').doc(businessId).get();
        let sysPrompt = 'You are a helpful, friendly customer service assistant.';
        let ownerEmail = '', botName = 'Assistant';

        if (botSnap.exists) {
            const b  = botSnap.data();
            ownerEmail = b.owner || '';
            botName    = b.name  || 'Assistant';
            const kc   = b.knowledgeContext || {};
            if (kc.systemPrompt) {
                sysPrompt = kc.systemPrompt;
            } else if (b.context) {
                sysPrompt = `You are a helpful, friendly customer service assistant for "${botName}". Use the following business information to answer questions accurately:\n\n${b.context}`;
            }
            if (kc.fileContents) {
                sysPrompt += `\n\n[REFERENCE DOCUMENTS]:\n${String(kc.fileContents).substring(0, 6000)}`;
            }
        }

        sysPrompt += `

PERSONALITY & BEHAVIOR:
- You are a warm, helpful customer service assistant. Answer questions naturally.
- Do NOT bring up appointment booking unless the user explicitly asks to book/schedule/set up an appointment.
- Greetings like "hello", "hi" get a natural, friendly response — no booking prompts.

APPOINTMENT BOOKING (only when user explicitly asks):
Collect information ONE piece at a time in EXACTLY this order:
  1. Full name    → ask: "What's your name?"
  2. Contact info → ask: "What's your email or phone number?"
  3. Date         → ask: "What date would you prefer?"
  4. Time         → ask: "What time works best for you on [date]?"

CRITICAL TIME RULES:
- You MUST ask for the time explicitly. Never assume or skip it.
- Valid times: "3 pm", "3:00 PM", "15:00", "morning", "afternoon", "evening", "noon".
- If the user provides a date without a time, ask: "What time works best for you on [date]?"
- Do NOT trigger the booking function until you have an explicit time confirmed.

OTHER RULES:
- Extract name from any phrasing: "I am Atharva", "It's Atharva", "My name is Atharva" → name is Atharva.
- Accept any date: "Monday", "19 June", "next Tuesday", "tomorrow", "17th June".
- Never re-ask for information already given in conversation history.
- Once you have all 4 fields confirmed, immediately call the appointmentBooking tool.
- NEVER output raw JSON or function arguments as plain text. That is a critical error.`;

        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const safeHistory = (Array.isArray(history) ? history : [])
            .slice(-12)
            .filter(m => m?.role && m?.content);

        const allText    = [...safeHistory.map(m => m.content), userMsg].join('\n');
        const allTextLow = allText.toLowerCase();

        // ── Strict field detection ────────────────────────────────────────────

        const hasName = (
            /my name is|i am|i'm|it'?s\s+[a-z]+|name[:\s]+/i.test(allText) ||
            safeHistory.some(m => m.role === 'user' && /^[A-Z][a-z]+ [A-Z][a-z]+/.test(m.content.trim()))
        );

        const hasContact = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/.test(allText) ||
                           /(\+?\d[\d\s\-]{6,}\d)/.test(allText);

        const hasDay = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}[\s\/\-](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}))\b/i.test(allTextLow);

        // STRICT: must be an actual time expression — not "book", "schedule", etc.
        const hasTime = /\b(\d{1,2}(:\d{2})?\s*(am|pm))\b/i.test(allText) ||
                        /\b(morning|afternoon|evening|noon|midday|midnight)\b/i.test(allTextLow) ||
                        /\b([01]?\d|2[0-3]):[0-5]\d\b/.test(allText);

        const isBookingConversation = /\b(book|schedule|appointment|slot|reserve|set up|fix a)\b/i.test(allTextLow);
        const allFieldsPresent = isBookingConversation && hasName && hasContact && hasDay && hasTime;

        const completion = await groq.chat.completions.create({
            model:    'llama-3.3-70b-versatile',
            messages: [
                { role: 'system', content: sysPrompt },
                ...safeHistory,
                { role: 'user', content: userMsg }
            ],
            tools: [{
                type: 'function',
                function: {
                    name: 'appointmentBooking',
                    description: 'Book an appointment. Call ONLY when you have confirmed: full name, contact info, date, AND an explicit time from the user.',
                    parameters: {
                        type: 'object',
                        properties: {
                            userName:        { type: 'string', description: 'Full name of the customer' },
                            contactInfo:     { type: 'string', description: 'Email or phone number' },
                            appointmentDay:  { type: 'string', description: 'Date or day of the appointment' },
                            appointmentTime: { type: 'string', description: 'Exact time as stated by the user, e.g. "3 pm", "3:30 PM", "morning"' }
                        },
                        required: ['userName', 'contactInfo', 'appointmentDay', 'appointmentTime']
                    }
                }
            }],
            tool_choice: allFieldsPresent
                ? { type: 'function', function: { name: 'appointmentBooking' } }
                : 'auto',
            temperature: 0.3,
            max_tokens:  600
        });

        const choice = completion.choices[0]?.message;

        // ── Safety net: catch leaked JSON ─────────────────────────────────────
        if (choice?.content && !choice?.tool_calls) {
            const jsonMatch = choice.content.match(/\{[\s\S]*?"userName"[\s\S]*?"contactInfo"[\s\S]*?\}/);
            if (jsonMatch) {
                try {
                    const leaked = JSON.parse(jsonMatch[0]);
                    if (leaked.userName && leaked.contactInfo && leaked.appointmentDay && leaked.appointmentTime) {
                        console.warn('[Chat] Intercepted leaked JSON, processing as booking');
                        choice.tool_calls = [{ function: { name: 'appointmentBooking', arguments: JSON.stringify(leaked) } }];
                        choice.content = null;
                    }
                } catch { /* not valid JSON */ }
            }
        }

        // ── Handle booking tool call ──────────────────────────────────────────
        if (choice?.tool_calls?.[0]?.function?.name === 'appointmentBooking') {
            let args;
            try { args = JSON.parse(choice.tool_calls[0].function.arguments); }
            catch { return res.json({ success: true, answer: 'Could you confirm your booking details again?' }); }

            const { userName, contactInfo, appointmentDay, appointmentTime } = args;

            // Guard: time is missing or placeholder
            if (!appointmentTime || appointmentTime.trim() === '' || /^tbd$/i.test(appointmentTime.trim())) {
                return res.json({
                    success: true,
                    answer: `Got it! Just one more thing — what time works best for you on ${appointmentDay}?`
                });
            }

            if (!userName || !contactInfo || !appointmentDay) {
                return res.json({
                    success: true,
                    answer: 'I need your name, contact info, preferred date and time to complete the booking. What would you like to provide?'
                });
            }

            const dateISO = resolveDay(appointmentDay);

            // ── Availability check (Google Calendar) ──────────────────────────
            if (ownerEmail) {
                const userSnap   = await db.collection('users').doc(ownerEmail).get();
                const integrations = userSnap.exists ? (userSnap.data()?.integrations || {}) : {};

                if (integrations.google_calendar?.connected) {
                    const avail = await checkCalendarAvailability(
                        integrations.google_calendar, dateISO, appointmentTime, ownerEmail, db
                    );

                    if (!avail.available) {
                        const alts = avail.suggestedTimes || [];
                        let altText = alts.length > 0
                            ? '\n\nHere are 3 available slots on that day:\n' +
                              alts.map((t, i) => `  ${i + 1}. ${t}`).join('\n') +
                              '\n\nWhich one works for you?'
                            : '\n\nWould you like to pick a different date or time?';

                        return res.json({
                            success: true,
                            answer: `Sorry, ${appointmentTime} on ${appointmentDay} is already booked.${altText}`
                        });
                    }
                }
            }

            // ── Save appointment record ───────────────────────────────────────
            const appt = {
                businessId, botName, owner: ownerEmail, conversationId: convId,
                customerName: userName, contactInfo,
                appointmentDay, appointmentTime, scheduledDate: dateISO,
                status: 'confirmed', createdAt: new Date().toISOString()
            };

            await db.collection('appointments').add(appt);
            await db.collection('user_bots').doc(businessId).collection('appointments').add(appt);

            // ── Integrations ──────────────────────────────────────────────────
            if (ownerEmail) {
                const userSnap     = await db.collection('users').doc(ownerEmail).get();
                const integrations = userSnap.exists ? (userSnap.data()?.integrations || {}) : {};
                if (integrations.google_calendar?.connected) {
                    try { await addCalendarEvent(integrations.google_calendar, appt, ownerEmail, db); }
                    catch (e) { console.error('[Chat/Calendar]', e.message); }
                }
                if (integrations.whatsappAlerts?.connected) {
                    try { await sendWANotification(integrations.whatsappAlerts, appt); }
                    catch (e) { console.error('[Chat/WhatsApp]', e.message); }
                }
            }

            await db.collection('user_bots').doc(businessId).collection('chats').add({
                conversationId: convId, question: userMsg,
                answer: 'Appointment booked.', isGenuineQuery: true, isLeadCaptured: true,
                createdAt: new Date().toISOString()
            });

            // ── Confirmation — exactly matches the design image ───────────────
            //    ✅ APPOINTMENT BOOKED
            //    NAME:     ...
            //    CONTACT:  ...
            //    DATE:     ...
            //    TIME:     ...
            //    Reply with "CANCEL"... "EDIT"...
            const pad = (label) => label.padEnd(8);
            const answer = [
                '✅ APPOINTMENT BOOKED',
                '',
                `${pad('NAME:')}    ${userName}`,
                `${pad('CONTACT:')} ${contactInfo}`,
                `${pad('DATE:')}    ${dateISO}`,
                `${pad('TIME:')}    ${appointmentTime}`,
                '',
                'Reply with "CANCEL" to cancel the appointment and "EDIT" to change a detail.'
            ].join('\n');

            return res.json({ success: true, answer, reply: answer });
        }

        // ── Plain reply ───────────────────────────────────────────────────────
        const answer = choice?.content?.trim() || 'How can I help you?';
        try {
            await db.collection('user_bots').doc(businessId).collection('chats').add({
                conversationId: convId, question: userMsg, answer,
                isGenuineQuery: true, isLeadCaptured: false,
                createdAt: new Date().toISOString()
            });
        } catch (e) { console.warn('[Chat] Log error:', e.message); }

        return res.json({ success: true, answer, reply: answer });

    } catch (err) {
        console.error('[Chat]', err.message);
        return res.status(500).json({
            success: false,
            answer: 'Something went wrong. Please try again.',
            reply:  'Something went wrong.'
        });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// ROI
// ════════════════════════════════════════════════════════════════════════════
async function handleROI(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { businessId } = req.body || {};
    if (!businessId) return res.status(400).json({ success: false, message: 'Missing businessId.' });
    try {
        const snap = await getDb().collection('user_bots').doc(businessId).collection('chats').get();
        let total = 0, genuine = 0, leads = 0;
        snap.forEach(d => {
            total++;
            const c = d.data();
            if (c.isGenuineQuery !== false) genuine++;
            if (c.isLeadCaptured) leads++;
        });
        const hoursSaved     = parseFloat(((genuine * 15) / 60).toFixed(1));
        const moneySaved     = parseFloat((genuine * 5 + leads * 50).toFixed(2));
        const resolutionRate = genuine > 0 ? Math.round(((genuine - leads) / genuine) * 100) : 100;
        return res.json({ success: true, totalConversations: total, hoursSaved, moneySaved, leadsCaptured: leads, resolutionRate });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// WHATSAPP VERIFY
// ════════════════════════════════════════════════════════════════════════════
async function handleWAVerify(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { userEmail, phoneNumber } = req.body || {};
    if (!userEmail || !phoneNumber)
        return res.status(400).json({ success: false, message: 'Missing userEmail or phoneNumber.' });

    let to = phoneNumber.replace(/[\s\-\(\)]/g, '');
    if (!to.startsWith('+')) to = '+' + to;
    const toWA = to.replace(/^\+/, '');

    const code      = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    try {
        await getDb().collection('whatsapp_verifications').doc(userEmail).set({
            verificationCode: code, phoneNumber: to, expiresAt, attempts: 0,
            createdAt: new Date().toISOString()
        });

        const waPhoneId = process.env.WA_BUSINESS_PHONE_NUMBER_ID;
        const waToken   = process.env.WA_ACCESS_TOKEN;

        if (waPhoneId && waToken) {
            const waRes = await fetch(`https://graph.facebook.com/v19.0/${waPhoneId}/messages`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${waToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messaging_product: 'whatsapp', to: toWA, type: 'text',
                    text: { body: `Your Comex AI verification code is: *${code}*\n\nExpires in 10 minutes. Do not share this code.` }
                })
            });
            const waData = await waRes.json();
            if (!waRes.ok) {
                console.error('[WA-Business]', JSON.stringify(waData));
                return res.status(500).json({ success: false, message: waData.error?.message || 'WhatsApp Business API error.' });
            }
            return res.json({ success: true, message: `Code sent to ${to} via WhatsApp.`, provider: 'whatsapp-business' });
        }

        const sid   = process.env.TWILIO_ACCOUNT_SID;
        const token = process.env.TWILIO_AUTH_TOKEN;
        const from  = process.env.TWILIO_WHATSAPP_NUMBER;

        if (!sid || !token || !from) {
            return res.status(500).json({
                success: false,
                message: 'WhatsApp not configured. Add WA_BUSINESS_PHONE_NUMBER_ID + WA_ACCESS_TOKEN OR Twilio credentials.'
            });
        }

        const twRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                From: `whatsapp:${from}`, To: `whatsapp:${to}`,
                Body: `Your Comex AI verification code is: *${code}*\n\nExpires in 10 minutes. Do not share.`
            })
        });

        const twData = await twRes.json();
        if (!twRes.ok) {
            if (twData.code === 63016) {
                return res.status(400).json({
                    success: false, code: 'NOT_OPTED_IN',
                    message: `Your WhatsApp number hasn't joined the Twilio sandbox. Send "join <your-keyword>" to ${from} on WhatsApp first.`
                });
            }
            return res.status(500).json({ success: false, message: twData.message || 'Twilio error.' });
        }

        return res.json({ success: true, message: `Code sent to ${to} via WhatsApp.`, provider: 'twilio' });

    } catch (err) {
        console.error('[WA-Verify]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// WHATSAPP CONFIRM
// ════════════════════════════════════════════════════════════════════════════
async function handleWAConfirm(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { userEmail, verificationCode } = req.body || {};
    if (!userEmail || !verificationCode)
        return res.status(400).json({ success: false, message: 'Missing userEmail or verificationCode.' });

    try {
        const db   = getDb();
        const ref  = db.collection('whatsapp_verifications').doc(userEmail);
        const snap = await ref.get();
        if (!snap.exists)
            return res.status(404).json({ success: false, message: 'No pending verification. Please start again.' });

        const data = snap.data();
        if (Date.now() > new Date(data.expiresAt).getTime()) {
            await ref.delete();
            return res.status(400).json({ success: false, message: 'Code expired. Please request a new one.' });
        }

        const attempts = (data.attempts || 0) + 1;
        if (data.verificationCode !== verificationCode.trim()) {
            if (attempts >= 3) {
                await ref.delete();
                return res.status(400).json({ success: false, message: 'Too many wrong attempts. Please start again.' });
            }
            await ref.update({ attempts });
            return res.status(400).json({ success: false, message: `Wrong code. ${3 - attempts} attempt(s) left.` });
        }

        await db.collection('users').doc(userEmail).set({
            integrations: { whatsappAlerts: { connected: true, phoneNumber: data.phoneNumber, verifiedAt: new Date().toISOString() } }
        }, { merge: true });
        await ref.delete();
        return res.json({ success: true, message: 'WhatsApp connected successfully!' });
    } catch (err) {
        console.error('[WA-Confirm]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// GOOGLE OAUTH — initiate
// ════════════════════════════════════════════════════════════════════════════
async function handleGoogleOAuth(req, res) {
    const { email, origin } = req.query;
    if (!email) return res.status(400).send('Missing email.');

    const clientId    = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI ||
                        `https://${req.headers.host}/api/oauth/google/callback`;
    if (!clientId) return res.status(500).send('Missing GOOGLE_CLIENT_ID env var.');

    const state = Buffer.from(JSON.stringify({ email, origin: origin || null })).toString('base64');
    const url   = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id',     clientId);
    url.searchParams.set('redirect_uri',  redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope',         'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events');
    url.searchParams.set('access_type',   'offline');
    url.searchParams.set('prompt',        'consent');
    url.searchParams.set('state',         state);

    return res.redirect(302, url.toString());
}

// ════════════════════════════════════════════════════════════════════════════
// GOOGLE OAUTH — callback
// ════════════════════════════════════════════════════════════════════════════
async function handleGoogleCallback(req, res) {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`OAuth error: ${error}`);
    if (!code || !state) return res.status(400).send('Missing code or state.');

    let email = '', origin = null;
    try {
        const parsed = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
        email  = parsed.email;
        origin = parsed.origin;
    } catch {
        return res.status(400).send('Invalid state parameter.');
    }

    const clientId     = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri  = process.env.GOOGLE_REDIRECT_URI ||
                         `https://${req.headers.host}/api/oauth/google/callback`;
    if (!clientId || !clientSecret) return res.status(500).send('Missing Google OAuth env vars.');

    try {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code, client_id: clientId, client_secret: clientSecret,
                redirect_uri: redirectUri, grant_type: 'authorization_code'
            })
        });

        const tokens = await tokenRes.json();
        if (tokens.error) return res.status(400).send(`Token error: ${tokens.error_description || tokens.error}`);

        await getDb().collection('users').doc(email).set({
            integrations: {
                google_calendar: {
                    connected:     true,
                    access_token:  tokens.access_token,
                    refresh_token: tokens.refresh_token || null,
                    expiry_date:   tokens.expires_in
                        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
                        : new Date(Date.now() + 3600 * 1000).toISOString()
                }
            }
        }, { merge: true });

        const appUrl = origin ||
                       process.env.APP_URL ||
                       `https://${req.headers.host.replace('comex-backend', 'cometchat-ai-platform').replace('.vercel.app', '.web.app')}`;

        return res.redirect(302, `${appUrl}?calendar_connected=1`);

    } catch (err) {
        console.error('[OAuth/Google]', err.message);
        return res.status(500).send(`Server error: ${err.message}`);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// TRUST & SAFETY / ACCOUNT MODERATION
// ════════════════════════════════════════════════════════════════════════════
//
// Signals collected:
//   - bad_word_bot_name   : a deployed bot's name matches a public bad-words list
//   - rapid_signup        : 3+ accounts created from the same device/IP within 30 min
//   - dormant_account     : no login in 150+ days (checked by the daily cron sweep)
//   - location_anomaly    : login from a very different location shortly after a prior
//                           login elsewhere (impossible-travel style hacking signal)
//
// An LLM (via the existing Groq setup) is the actual decision-maker — it looks at
// whatever signals exist and decides disable / enable / permanent_disable / none.
// This avoids brittle hard thresholds and lets the review flow (the same function,
// called again with the user's appeal text) reuse the exact same judgement logic.

let _badWordsCache = { list: null, fetchedAt: 0 };
const BAD_WORDS_URL = 'https://raw.githubusercontent.com/LDNOOBWV2/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words_V2/main/data/en.txt';

async function getBadWordsSet() {
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    if (_badWordsCache.list && (Date.now() - _badWordsCache.fetchedAt) < SIX_HOURS) {
        return _badWordsCache.list;
    }
    try {
        const r = await fetch(BAD_WORDS_URL);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text  = await r.text();
        const words = text.split('\n').map(w => w.trim().toLowerCase()).filter(Boolean);
        _badWordsCache = { list: new Set(words), fetchedAt: Date.now() };
        return _badWordsCache.list;
    } catch (err) {
        console.error('[Moderation] Failed to fetch bad-words list:', err.message);
        return _badWordsCache.list || new Set(); // serve stale cache, or empty if none yet
    }
}

/** Returns the matched bad word, or null. Never logged/shown to end users. */
function textContainsBadWord(text, badWordsSet) {
    if (!text || !badWordsSet || badWordsSet.size === 0) return null;
    const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const tokens = normalized.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
        if (badWordsSet.has(token)) return token;
    }
    const slug = normalized.replace(/\s+/g, '');
    if (slug.length >= 4) {
        for (const w of badWordsSet) {
            if (w.length >= 4 && slug.includes(w)) return w;
        }
    }
    return null;
}

function getClientIP(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return fwd.split(',')[0].trim();
    return req.socket?.remoteAddress || '';
}

/** Free IP geolocation — no key required. HTTP-only endpoint (ip-api.com free tier). */
async function geolocateIP(ip) {
    if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) {
        return { country: 'Local/Unknown', regionName: '', city: '', lat: null, lon: null, query: ip || '' };
    }
    try {
        const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city,lat,lon,query`);
        const data = await r.json();
        if (data.status !== 'success') return null;
        return data;
    } catch (err) {
        console.error('[Moderation] Geolocation failed:', err.message);
        return null;
    }
}

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
    if ([lat1, lon1, lat2, lon2].some(v => v === null || v === undefined)) return 0;
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * The AI adjudicator. Given behavioral signals (and optionally an appeal message,
 * meaning this is a review of an already-disabled account), decides what to do.
 * Always returns { action, reason } — defaults to "none" on any failure so a
 * broken API call never accidentally locks anyone out.
 */
async function aiEvaluateAccount(email, signals, appealText = null) {
    if (!process.env.GROQ_API_KEY) {
        return { action: 'none', reason: 'Moderation AI not configured — skipping review.' };
    }
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const sysPrompt = `You are an account security & trust-and-safety reviewer for a SaaS platform called Comex AI.
You are given behavioral signals collected about a user account, and optionally an appeal message the user wrote requesting reinstatement.

Respond with STRICT JSON only — no markdown, no preamble — in exactly this shape:
{"action": "none" | "disable" | "enable" | "permanent_disable", "reason": "one clear sentence explaining the decision, written for the end user"}

Rules:
- Use "disable" only when reviewing a currently-active account and the signals show clear evidence of abuse: an offensive/obscene word in a deployed bot's name, rapid multi-account creation from the same device/IP in a short window, a genuine location/travel anomaly consistent with account takeover, or other concrete signs of hacking. A single weak or ambiguous signal (e.g. dormancy alone) is not enough on its own.
- Use "none" when signals are benign, weak, or insufficient.
- If an appeal message is present, this account is already disabled and the user is requesting reinstatement: choose "enable" if the appeal is credible and the original signals look like false positives or have been addressed; choose "permanent_disable" only if the evidence still clearly shows real abuse.
- Be fair and proportionate. Don't be swayed by hostility or begging alone — weigh the appeal against the actual evidence.
- Never invent evidence that isn't in the signals provided.`;

    const userContent = JSON.stringify({ email, signals, appealText }, null, 2);

    try {
        const completion = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [
                { role: 'system', content: sysPrompt },
                { role: 'user', content: userContent }
            ],
            temperature: 0.2,
            max_tokens: 300,
            response_format: { type: 'json_object' }
        });
        const raw = completion.choices[0]?.message?.content || '{}';
        const parsed = JSON.parse(raw);
        if (!['none', 'disable', 'enable', 'permanent_disable'].includes(parsed.action)) {
            return { action: 'none', reason: 'Moderation AI response malformed — no action taken.' };
        }
        return parsed;
    } catch (err) {
        console.error('[Moderation] AI evaluation failed:', err.message);
        return { action: 'none', reason: 'Moderation AI review failed — no action taken.' };
    }
}

/**
 * Applies a moderation decision against both Firebase Auth (the actual login gate)
 * and the Firestore user doc (for status/reason display in the UI).
 *
 * NOTE on "enable": we set status to "reinstated" rather than "active" so the
 * frontend gets one chance to show a "you're back!" screen before the user
 * proceeds — see /api/moderation/acknowledge.
 */
async function applyModerationAction(email, action, reason, db) {
    const userRef = db.collection('users').doc(email);
    const now = new Date().toISOString();

    if (action === 'disable') {
        try {
            const authUser = await admin.auth().getUserByEmail(email);
            await admin.auth().updateUser(authUser.uid, { disabled: true });
            await admin.auth().revokeRefreshTokens(authUser.uid);
        } catch (e) { console.error('[Moderation] Firebase disable error:', e.message); }
        await userRef.set({ moderation: { status: 'disabled', disabledAt: now, disabledReason: reason } }, { merge: true });
    }

    if (action === 'enable') {
        try {
            const authUser = await admin.auth().getUserByEmail(email);
            await admin.auth().updateUser(authUser.uid, { disabled: false });
        } catch (e) { console.error('[Moderation] Firebase enable error:', e.message); }
        await userRef.set({
            moderation: {
                status: 'reinstated', reviewDecision: 'enabled', reviewDecisionAt: now,
                reviewDecisionReason: reason, permanentDeleteAt: null
            }
        }, { merge: true });
    }

    if (action === 'permanent_disable') {
        const permanentDeleteAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
        await userRef.set({
            moderation: {
                status: 'permanently_disabled', reviewDecision: 'permanently_disabled',
                reviewDecisionAt: now, reviewDecisionReason: reason, permanentDeleteAt
            }
        }, { merge: true });
    }
}

async function permanentlyDeleteAccount(email, db) {
    try {
        const authUser = await admin.auth().getUserByEmail(email).catch(() => null);
        if (authUser) await admin.auth().deleteUser(authUser.uid);
    } catch (e) { console.error('[Moderation] Auth delete error:', e.message); }
    try {
        await db.collection('users').doc(email).delete();
    } catch (e) { console.error('[Moderation] Firestore user delete error:', e.message); }
}

// ── Route: reported on every signup/login from the client ───────────────────
async function handleAuthEvent(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { email, type, fingerprint } = req.body || {};
    if (!email || !type) return res.status(400).json({ success: false, message: 'Missing email or type.' });

    const db  = getDb();
    const ip  = getClientIP(req);
    const now = new Date().toISOString();
    const geo = await geolocateIP(ip);

    try {
        if (type === 'signup') {
            await db.collection('signup_events').add({ email, fingerprint: fingerprint || null, ip, geo, createdAt: now });

            // Rapid signup check: same fingerprint OR IP in the last 30 minutes
            const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
            const recentSnap = await db.collection('signup_events').where('createdAt', '>=', thirtyMinAgo).get();

            let sameDeviceCount = 0;
            recentSnap.forEach(d => {
                const e = d.data();
                if ((fingerprint && e.fingerprint === fingerprint) || (ip && e.ip === ip)) sameDeviceCount++;
            });

            await db.collection('users').doc(email).set({
                createdAt: now,
                moderation: { status: 'active', signals: { signupIP: ip, signupFingerprint: fingerprint || null, signupGeo: geo || null } }
            }, { merge: true });

            if (sameDeviceCount >= 3) {
                const signals = { rapid_signup: { count: sameDeviceCount, windowMinutes: 30, ip, fingerprint: fingerprint || null } };
                await db.collection('users').doc(email).set({ moderation: { signals } }, { merge: true });
                const decision = await aiEvaluateAccount(email, signals);
                if (decision.action === 'disable') await applyModerationAction(email, 'disable', decision.reason, db);
            }
        }

        if (type === 'login') {
            const userRef  = db.collection('users').doc(email);
            const userSnap = await userRef.get();
            const prevModeration = userSnap.exists ? (userSnap.data().moderation || {}) : {};
            const prevGeo     = prevModeration.lastLoginGeo;
            const prevLoginAt = prevModeration.lastLoginAt;

            const flags = {};
            if (prevLoginAt) {
                const daysSince = (Date.now() - new Date(prevLoginAt).getTime()) / 86400000;
                if (daysSince > 150) flags.dormant_return = { daysSinceLastLogin: Math.round(daysSince) };
            }
            if (prevGeo && geo && prevGeo.country && geo.country && prevGeo.country !== geo.country) {
                const hoursSince = prevLoginAt ? (Date.now() - new Date(prevLoginAt).getTime()) / 3600000 : 999;
                const distanceKm = haversineDistanceKm(prevGeo.lat, prevGeo.lon, geo.lat, geo.lon);
                const impossibleSpeedKmh = hoursSince > 0 ? distanceKm / hoursSince : 0;
                // Faster than any commercial flight ⇒ very likely two different people/devices
                if (hoursSince < 6 && impossibleSpeedKmh > 900) {
                    flags.location_anomaly = {
                        from: prevGeo.country, to: geo.country,
                        hoursSinceLastLogin: Math.round(hoursSince * 10) / 10,
                        distanceKm: Math.round(distanceKm)
                    };
                }
            }

            await userRef.set({
                moderation: {
                    lastLoginAt: now, lastLoginIP: ip, lastLoginGeo: geo || null,
                    lastLoginFingerprint: fingerprint || null,
                    signals: flags
                }
            }, { merge: true });

            if (Object.keys(flags).length > 0) {
                const decision = await aiEvaluateAccount(email, flags);
                if (decision.action === 'disable') await applyModerationAction(email, 'disable', decision.reason, db);
            }
        }

        return res.json({ success: true });
    } catch (err) {
        console.error('[AuthEvent]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ── Route: frontend polls this to know what screen to show ──────────────────
async function handleModerationStatus(req, res) {
    const { email } = req.query;
    if (!email) return res.status(400).json({ success: false, message: 'Missing email.' });
    try {
        const snap = await getDb().collection('users').doc(email).get();
        if (!snap.exists) return res.json({ success: true, status: 'active' });
        const m = snap.data().moderation || {};
        return res.json({
            success: true,
            status: m.status || 'active',
            disabledReason: m.disabledReason || null,
            reviewDecision: m.reviewDecision || null,
            reviewDecisionReason: m.reviewDecisionReason || null,
            permanentDeleteAt: m.permanentDeleteAt || null
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ── Route: user submits an appeal from the "Account Disabled" screen ────────
async function handleRequestReview(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { email, text } = req.body || {};
    if (!email || !text || !text.trim())
        return res.status(400).json({ success: false, message: 'Missing email or review text.' });

    const db = getDb();
    try {
        const userRef = db.collection('users').doc(email);
        const snap = await userRef.get();
        if (!snap.exists) return res.status(404).json({ success: false, message: 'Account not found.' });
        const moderation = snap.data().moderation || {};

        if (moderation.status !== 'disabled') {
            return res.status(400).json({ success: false, message: 'Account is not currently disabled.' });
        }

        await userRef.set({
            moderation: { status: 'under_review', reviewRequestedAt: new Date().toISOString(), reviewText: text.trim() }
        }, { merge: true });

        const decision = await aiEvaluateAccount(email, moderation.signals || {}, text.trim());

        // If the AI can't reach a confident enable/permanent_disable verdict on an
        // appeal, default to reinstating the account rather than compounding the
        // punishment on ambiguous evidence.
        let finalAction = decision.action;
        let finalReason = decision.reason;
        if (finalAction !== 'enable' && finalAction !== 'permanent_disable') {
            finalAction = 'enable';
            finalReason = finalReason || 'Insufficient evidence to sustain the suspension — account reinstated.';
        }

        await applyModerationAction(email, finalAction, finalReason, db);
        return res.json({ success: true, message: 'Your appeal has been submitted for review.' });
    } catch (err) {
        console.error('[RequestReview]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ── Route: self-service immediate deletion once permanently disabled ────────
async function handleDeleteNow(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ success: false, message: 'Missing email.' });
    try {
        const db = getDb();
        const snap = await db.collection('users').doc(email).get();
        const status = snap.exists ? snap.data().moderation?.status : null;
        if (status !== 'permanently_disabled') {
            return res.status(400).json({ success: false, message: 'Account is not scheduled for deletion.' });
        }
        await permanentlyDeleteAccount(email, db);
        return res.json({ success: true, message: 'Account deleted.' });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ── Route: user clicks "Continue to Dashboard" on the reinstated screen ─────
async function handleAcknowledgeReinstatement(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ success: false, message: 'Missing email.' });
    try {
        await getDb().collection('users').doc(email).set({ moderation: { status: 'active' } }, { merge: true });
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ── Route: daily Vercel Cron sweep ───────────────────────────────────────────
// Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` on cron
// invocations if you set a CRON_SECRET env var — set one so this endpoint
// can't be triggered by randoms hitting the URL.
async function handleDailySweep(req, res) {
    const authHeader = req.headers['authorization'] || '';
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }

    const db = getDb();
    const results = { dormantFlagged: 0, disabled: 0, deleted: 0, errors: [] };
    const now = Date.now();

    try {
        const usersSnap = await db.collection('users').get();

        for (const docSnap of usersSnap.docs) {
            const email = docSnap.id;
            const data = docSnap.data();
            const moderation = data.moderation || {};

            // 1) Permanently-disabled accounts past their 12-hour deletion deadline
            if (moderation.status === 'permanently_disabled' && moderation.permanentDeleteAt) {
                if (new Date(moderation.permanentDeleteAt).getTime() <= now) {
                    try { await permanentlyDeleteAccount(email, db); results.deleted++; }
                    catch (e) { results.errors.push(`${email}: ${e.message}`); }
                    continue;
                }
            }

            // 2) Dormant account sweep (150+ days since last login)
            if (moderation.status === 'active' && moderation.lastLoginAt) {
                const daysSince = (now - new Date(moderation.lastLoginAt).getTime()) / 86400000;
                if (daysSince > 150) {
                    results.dormantFlagged++;
                    const signals = { ...(moderation.signals || {}), dormant_account: { daysSinceLastLogin: Math.round(daysSince) } };
                    const decision = await aiEvaluateAccount(email, signals);
                    if (decision.action === 'disable') {
                        await applyModerationAction(email, 'disable', decision.reason, db);
                        results.disabled++;
                    }
                }
            }
        }

        return res.json({ success: true, results });
    } catch (err) {
        console.error('[DailySweep]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Resolve any natural-language date string to YYYY-MM-DD (local date, no TZ shift).
 */
function resolveDay(dayName) {
    if (!dayName) return new Date().toISOString().split('T')[0];
    const input = dayName.trim();
    const lower = input.toLowerCase();

    if (lower === 'today') {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
    if (lower === 'tomorrow') {
        const d = new Date(); d.setDate(d.getDate() + 1);
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }

    const months = {
        january:0, february:1, march:2, april:3, may:4, june:5,
        july:6, august:7, september:8, october:9, november:10, december:11,
        jan:0, feb:1, mar:2, apr:3, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11
    };

    // "19 june", "19 june 2026", "19th june"
    const dmyMatch = lower.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:\s+(\d{4}))?$/);
    if (dmyMatch) {
        const day  = parseInt(dmyMatch[1], 10);
        const mon  = months[dmyMatch[2]];
        const year = dmyMatch[3] ? parseInt(dmyMatch[3], 10) : new Date().getFullYear();
        if (mon !== undefined) {
            // Use local Date constructor — no UTC conversion
            const d = new Date(year, mon, day);
            if (!dmyMatch[3] && d < new Date()) d.setFullYear(d.getFullYear() + 1);
            return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        }
    }

    // "june 19", "june 19 2026"
    const mdyMatch = lower.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/);
    if (mdyMatch) {
        const mon  = months[mdyMatch[1]];
        const day  = parseInt(mdyMatch[2], 10);
        const year = mdyMatch[3] ? parseInt(mdyMatch[3], 10) : new Date().getFullYear();
        if (mon !== undefined) {
            const d = new Date(year, mon, day);
            if (!mdyMatch[3] && d < new Date()) d.setFullYear(d.getFullYear() + 1);
            return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        }
    }

    // Weekday names: "Monday", "next Monday"
    const days    = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const cleaned = lower.replace(/^next\s+/, '').trim();
    const target  = days.indexOf(cleaned);
    if (target !== -1) {
        const today = new Date();
        let diff = target - today.getDay();
        if (diff <= 0) diff += 7;
        const d = new Date(today);
        d.setDate(today.getDate() + diff);
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }

    // Fallback: try native parse but strip time to avoid TZ issues
    const dateAttempt = new Date(input.includes('T') ? input : `${input}T12:00:00`);
    if (!isNaN(dateAttempt.getTime())) {
        return `${dateAttempt.getFullYear()}-${String(dateAttempt.getMonth()+1).padStart(2,'0')}-${String(dateAttempt.getDate()).padStart(2,'0')}`;
    }

    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}

/**
 * Parse a time string → { h, min } or null if unrecognisable.
 * Returns null instead of silently defaulting to 09:00.
 */
function parseTime(timeStr) {
    if (!timeStr) return null;
    const s = timeStr.trim().toLowerCase();

    if (s === 'morning')                return { h: 9,  min: 0 };
    if (s === 'afternoon')              return { h: 14, min: 0 };
    if (s === 'evening')                return { h: 18, min: 0 };
    if (s === 'noon' || s === 'midday') return { h: 12, min: 0 };
    if (s === 'midnight')               return { h: 0,  min: 0 };

    // "3 pm", "3:30pm", "3:30 pm", "15:00", "3"
    const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (m) {
        let h   = parseInt(m[1], 10);
        const min = parseInt(m[2] || '0', 10);
        if (m[3] === 'pm' && h !== 12) h += 12;
        if (m[3] === 'am' && h === 12) h  = 0;
        if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return { h, min };
    }

    return null;
}

/**
 * Fetch the owner's Google Calendar primary timezone (e.g. "Asia/Kolkata").
 * Falls back to 'UTC' on any error.
 */
async function getCalendarTimezone(accessToken) {
    try {
        const r = await fetch(
            'https://www.googleapis.com/calendar/v3/calendars/primary',
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!r.ok) return 'UTC';
        const data = await r.json();
        return data.timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

/**
 * Refresh access token if expiring soon. Returns current (or refreshed) token.
 */
async function refreshTokenIfNeeded(googleAuth, ownerEmail, db) {
    let accessToken = googleAuth.access_token;
    if (googleAuth.refresh_token && googleAuth.expiry_date) {
        const expiryMs = new Date(googleAuth.expiry_date).getTime();
        if (!isNaN(expiryMs) && expiryMs < Date.now() + 60000) {
            const r = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id:     process.env.GOOGLE_CLIENT_ID,
                    client_secret: process.env.GOOGLE_CLIENT_SECRET,
                    refresh_token: googleAuth.refresh_token,
                    grant_type:    'refresh_token'
                })
            });
            const t = await r.json();
            if (t.access_token) {
                accessToken = t.access_token;
                await db.collection('users').doc(ownerEmail).update({
                    'integrations.google_calendar.access_token': t.access_token,
                    'integrations.google_calendar.expiry_date':
                        new Date(Date.now() + (t.expires_in || 3500) * 1000).toISOString()
                });
            } else {
                console.error('[Calendar/Refresh] Failed:', t);
            }
        }
    }
    return accessToken;
}

/**
 * Check if a time slot is free on Google Calendar.
 * Returns { available: true } or { available: false, suggestedTimes: ['10:00 AM', ...] }
 *
 * KEY FIX: We fetch the calendar's own timezone, then build the query window
 * using a local dateTime string + that timezone — exactly the same way we
 * create events — so the availability window matches what the user sees.
 */
async function checkCalendarAvailability(googleAuth, dateISO, timeStr, ownerEmail, db) {
    try {
        const accessToken = await refreshTokenIfNeeded(googleAuth, ownerEmail, db);
        const timeZone    = await getCalendarTimezone(accessToken);

        const parsed = parseTime(timeStr);
        if (!parsed) return { available: true }; // can't parse — let it through

        const { h, min } = parsed;

        // Build local start/end as wall-clock strings in the owner's timezone
        const localStart = `${dateISO}T${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:00`;
        const endH   = h + Math.floor((min + 60) / 60);   // +1 hour window
        const endMin = (min + 60) % 60;
        const localEnd   = `${dateISO}T${String(endH).padStart(2,'0')}:${String(endMin).padStart(2,'0')}:00`;

        // Convert local wall-clock strings → UTC ISO for the API query
        const toUTC = (localStr, tz) => {
            // Intl trick: find what UTC instant == this local time in tz
            const naive = new Date(localStr + 'Z');
            const fmt   = new Intl.DateTimeFormat('en-CA', {
                timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit',
                hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
            });
            const parts  = fmt.formatToParts(naive);
            const get    = type => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
            const tzH    = get('hour') === 24 ? 0 : get('hour');
            const represented = Date.UTC(get('year'), get('month')-1, get('day'), tzH, get('minute'), get('second'));
            const desired     = naive.getTime();
            return new Date(naive.getTime() - (represented - desired));
        };

        const startUTC = toUTC(localStart, timeZone);
        const endUTC   = toUTC(localEnd,   timeZone);

        // Fetch all events on this day
        const dayLocalStart = `${dateISO}T00:00:00`;
        const dayLocalEnd   = `${dateISO}T23:59:59`;
        const dayStartUTC   = toUTC(dayLocalStart, timeZone);
        const dayEndUTC     = toUTC(dayLocalEnd,   timeZone);

        const r = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
            `timeMin=${dayStartUTC.toISOString()}&timeMax=${dayEndUTC.toISOString()}&singleEvents=true&orderBy=startTime`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        if (!r.ok) {
            console.error('[Availability] Calendar fetch failed:', r.status);
            return { available: true }; // fail open
        }

        const data   = await r.json();
        const events = data.items || [];

        // Check if requested slot overlaps any event
        const isBooked = events.some(ev => {
            const evStart = new Date(ev.start?.dateTime || ev.start?.date);
            const evEnd   = new Date(ev.end?.dateTime   || ev.end?.date);
            return startUTC < evEnd && endUTC > evStart;
        });

        if (!isBooked) return { available: true };

        // Find 3 free 30-min slots in business hours (9am–6pm local)
        const bookedRanges = events.map(ev => ({
            start: new Date(ev.start?.dateTime || ev.start?.date),
            end:   new Date(ev.end?.dateTime   || ev.end?.date)
        }));

        const suggestions = [];
        for (let sh = 9; sh < 18 && suggestions.length < 3; sh++) {
            for (let sm = 0; sm < 60 && suggestions.length < 3; sm += 30) {
                const slotLocalStr = `${dateISO}T${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}:00`;
                const slotStart    = toUTC(slotLocalStr, timeZone);
                const slotEnd      = new Date(slotStart.getTime() + 30 * 60000);
                const conflict     = bookedRanges.some(b => slotStart < b.end && slotEnd > b.start);
                if (!conflict) {
                    const dh  = sh % 12 === 0 ? 12 : sh % 12;
                    const dm  = String(sm).padStart(2, '0');
                    const per = sh < 12 ? 'AM' : 'PM';
                    suggestions.push(`${dh}:${dm} ${per}`);
                }
            }
        }

        return { available: false, suggestedTimes: suggestions };

    } catch (err) {
        console.error('[Availability]', err.message);
        return { available: true }; // fail open
    }
}

/**
 * Add event to Google Calendar at EXACTLY the time the user stated,
 * in the owner's local timezone — no UTC shift.
 *
 * KEY FIX: pass dateTime WITHOUT a 'Z' suffix + the correct timeZone string.
 * Google Calendar treats it as a wall-clock time in that zone, so a user
 * in IST (GMT+5:30) who says "3 pm" gets an event at 3 PM IST, not 3 PM UTC.
 */
async function addCalendarEvent(googleAuth, appt, ownerEmail, db) {
    const accessToken = await refreshTokenIfNeeded(googleAuth, ownerEmail, db);

    const parsed = parseTime(appt.appointmentTime);
    if (!parsed) {
        console.error(`[Calendar] Cannot parse time "${appt.appointmentTime}" — skipping event creation.`);
        return;
    }

    const { h, min } = parsed;
    const timeZone = await getCalendarTimezone(accessToken);

    // Local wall-clock datetime strings (NO 'Z' — intentional)
    const localStart = `${appt.scheduledDate}T${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:00`;
    const endH   = h + Math.floor((min + 30) / 60);
    const endMin = (min + 30) % 60;
    const localEnd = `${appt.scheduledDate}T${String(endH).padStart(2,'0')}:${String(endMin).padStart(2,'0')}:00`;

    console.log(`[Calendar] Creating event: ${localStart} → ${localEnd} in ${timeZone}`);

    const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            summary:     `Appointment: ${appt.customerName}`,
            description: `Contact: ${appt.contactInfo}\nBooked via Comex AI`,
            // No 'Z' on dateTime + timeZone = Google stores as local wall-clock time
            start: { dateTime: localStart, timeZone },
            end:   { dateTime: localEnd,   timeZone }
        })
    });

    const data = await r.json();
    if (!r.ok) console.error('[Calendar] Event creation error:', data.error?.message);
    else       console.log('[Calendar] Event created:', data.id, 'at', localStart, timeZone);
}

async function sendWANotification(waAuth, appt) {
    if (!waAuth.phoneNumber) return;
    let to = waAuth.phoneNumber.replace(/[\s\-\(\)]/g, '');
    if (!to.startsWith('+')) to = '+' + to;

    const body = `📅 *New Appointment Booked*\n\n👤 Name: ${appt.customerName}\n📧 Contact: ${appt.contactInfo}\n📆 Date: ${appt.scheduledDate}\n🕐 Time: ${appt.appointmentTime}\n\nBooked via Comex AI`;

    const waPhoneId = process.env.WA_BUSINESS_PHONE_NUMBER_ID;
    const waToken   = process.env.WA_ACCESS_TOKEN;
    if (waPhoneId && waToken) {
        const r = await fetch(`https://graph.facebook.com/v19.0/${waPhoneId}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${waToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: 'whatsapp', to: to.replace(/^\+/, ''), type: 'text', text: { body } })
        });
        if (!r.ok) { const d = await r.json(); console.error('[WA-Business] Send error:', d.error?.message); }
        return;
    }

    const sid   = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from  = process.env.TWILIO_WHATSAPP_NUMBER;
    if (!sid || !token || !from) return;

    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ From: `whatsapp:${from}`, To: `whatsapp:${to}`, Body: body })
    });
    if (!r.ok) { const d = await r.json(); console.error('[WA-Twilio] Send error:', d.message); }
}
