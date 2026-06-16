// api/index.js - Single serverless function router for Vercel Hobby plan

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

    if (path === '/api/chat')                       return handleChat(req, res);
    if (path === '/api/config')                     return handleConfig(req, res);
    if (path === '/api/scrape')                     return handleScrape(req, res);
    if (path === '/api/deploy')                     return handleDeploy(req, res);
    if (path === '/api/calculate-roi')              return handleROI(req, res);
    if (path === '/api/whatsapp-verify')            return handleWAVerify(req, res);
    if (path === '/api/whatsapp-verify-confirm')    return handleWAConfirm(req, res);
    if (path === '/api/oauth/google')               return handleGoogleOAuth(req, res);
    if (path === '/api/oauth/google/callback')      return handleGoogleCallback(req, res);

    return res.status(404).json({ success: false, message: `Unknown route: ${path}` });
}

// ════════════════════════════════════════════════════════════════════════════
// 1. DEPLOY
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
        await getDb().collection('user_bots').doc(botData.id).set(botData, { merge: true });
        return res.status(200).json({ success: true, botId: botData.id });
    } catch (err) {
        console.error('[Deploy]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// 2. SCRAPE
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
// 3. CONFIG
// ════════════════════════════════════════════════════════════════════════════
async function handleConfig(req, res) {
    const { businessId } = req.query;
    if (!businessId) return res.status(400).json({ success: false, error: 'Missing businessId.' });
    try {
        const snap = await getDb().collection('user_bots').doc(businessId).get();
        if (!snap.exists) return res.status(404).json({ success: false, error: 'Bot not found.' });
        const b = snap.data();
        return res.status(200).json({
            success: true,
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
// 4. CHAT
//
// FIXES:
//   1. Time detection is now strict — requires an explicit time like "3 pm",
//      "15:00", "morning", "afternoon" etc. Vague phrases don't count.
//   2. allFieldsPresent checks conversation history for EACH field independently
//      before triggering the tool call — prevents premature booking.
//   3. Confirmation message exactly matches the design image.
//   4. Calendar event uses the EXACT time the user provided, not a default.
//   5. If the requested slot is already booked, bot suggests 3 specific
//      available alternative times from that day.
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
- You are a warm, helpful customer service assistant. Answer questions naturally and helpfully.
- Do NOT bring up appointment booking unless the user explicitly asks to book/schedule/set up an appointment.
- If the user just says "hello", "hi", or anything that is not a booking request, respond naturally.

APPOINTMENT BOOKING (only when user explicitly asks):
Collect information ONE piece at a time in EXACTLY this order:
  1. Full name — ask "What's your name?"
  2. Contact info (email or phone) — ask "What's your email or phone number?"
  3. Preferred date — ask "What date would you prefer?"
  4. Preferred time — ask "What time works best for you?" ← ALWAYS ask this explicitly

CRITICAL TIME RULES:
- You MUST ask for a specific time. Never assume or default to a time.
- Only accept explicit times: "3 pm", "3:00 PM", "15:00", "morning", "afternoon", "evening", "noon".
- If the user gives a date but NOT a time, you MUST ask: "What time works best for you on [date]?"
- Do NOT call the booking function until you have a specific time confirmed.

CRITICAL RULES:
- Do NOT ask for information already provided in the conversation history.
- Extract name from any phrasing: "I am Atharva", "It's Atharva", "My name is Atharva" — all mean name is Atharva.
- Accept any date format: "Monday", "19 June", "next Tuesday", "tomorrow", "17th June".
- Once you have all 4 pieces (name, contact, date, time), silently call the appointmentBooking tool immediately.
- NEVER output raw JSON, curly braces {}, or function call arguments as plain text.
- Do not re-ask for any information already given.`;

        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const safeHistory = (Array.isArray(history) ? history : [])
            .slice(-12)
            .filter(m => m?.role && m?.content);

        const allText = [...safeHistory.map(m => m.content), userMsg].join('\n');
        const allTextLow = allText.toLowerCase();

        // ── Field detection (strict) ─────────────────────────────────────────

        // Name: any explicit name phrasing OR a standalone 2-word capitalized name
        const hasName = (
            /my name is|i am|i'm|it'?s\s+[a-z]+|name[:\s]+/i.test(allText) ||
            safeHistory.some(m => m.role === 'user' && /^[A-Z][a-z]+ [A-Z][a-z]+/.test(m.content.trim()))
        );

        // Contact: email address OR a phone-like number (7+ digits)
        const hasContact = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/.test(allText) ||
                           /(\+?\d[\d\s\-]{6,}\d)/.test(allText);

        // Date: day name or date pattern
        const hasDay = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}[\s\/\-](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}))\b/i.test(allTextLow);

        // ── STRICT time detection — must be an actual time expression ────────
        // Matches: "3 pm", "3:30pm", "15:00", "morning", "afternoon", "evening", "noon", "midday"
        // Does NOT match vague words like "schedule", "book", "appointment"
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
                    description: 'Book an appointment. Call ONLY when you have: full name, contact info, date, AND an explicit time. Never call this without a confirmed time.',
                    parameters: {
                        type: 'object',
                        properties: {
                            userName:        { type: 'string', description: 'Full name of the customer' },
                            contactInfo:     { type: 'string', description: 'Email or phone number' },
                            appointmentDay:  { type: 'string', description: 'Date or day of the appointment' },
                            appointmentTime: { type: 'string', description: 'Exact time of the appointment as provided by the user (e.g. "3:00 PM", "morning", "2 pm")' }
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

        // ── Safety net: intercept leaked JSON ────────────────────────────────
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
                } catch { /* not valid JSON — ignore */ }
            }
        }

        // ── Appointment tool call ─────────────────────────────────────────────
        if (choice?.tool_calls?.[0]?.function?.name === 'appointmentBooking') {
            let args;
            try { args = JSON.parse(choice.tool_calls[0].function.arguments); }
            catch { return res.json({ success: true, answer: 'Could you confirm your booking details again?' }); }

            const { userName, contactInfo, appointmentDay, appointmentTime } = args;

            // Guard: if time is still missing/vague after tool call, ask again
            if (!appointmentTime || appointmentTime.trim() === '' || appointmentTime.toLowerCase() === 'tbd') {
                return res.json({
                    success: true,
                    answer: `Got it! Just one more thing — what time works best for you on ${appointmentDay}?`
                });
            }

            if (!userName || !contactInfo || !appointmentDay) {
                return res.json({
                    success: true,
                    answer: "I need your name, contact info, preferred date and time to complete the booking. What would you like to provide?"
                });
            }

            const dateISO = resolveDay(appointmentDay);

            // ── Check calendar availability if Google Calendar is connected ──
            if (ownerEmail) {
                const userSnap = await db.collection('users').doc(ownerEmail).get();
                const integrations = userSnap.exists ? (userSnap.data()?.integrations || {}) : {};

                if (integrations.google_calendar?.connected) {
                    const availability = await checkCalendarAvailability(
                        integrations.google_calendar,
                        dateISO,
                        appointmentTime,
                        ownerEmail,
                        db
                    );

                    if (!availability.available) {
                        // Build 3 alternative time suggestions
                        const alts = availability.suggestedTimes || [];
                        let altText = '';
                        if (alts.length > 0) {
                            altText = '\n\nHere are 3 available slots on that day:\n' +
                                alts.map((t, i) => `  ${i + 1}. ${t}`).join('\n') +
                                '\n\nWhich one works for you?';
                        } else {
                            altText = '\n\nWould you like to pick a different date or time?';
                        }
                        return res.json({
                            success: true,
                            answer: `Sorry, ${appointmentTime} on ${appointmentDay} is already booked.${altText}`
                        });
                    }
                }
            }

            // ── Save appointment ──────────────────────────────────────────────
            const appt = {
                businessId, botName, owner: ownerEmail, conversationId: convId,
                customerName: userName, contactInfo,
                appointmentDay, appointmentTime, scheduledDate: dateISO,
                status: 'confirmed', createdAt: new Date().toISOString()
            };

            await db.collection('appointments').add(appt);
            await db.collection('user_bots').doc(businessId).collection('appointments').add(appt);

            // ── Trigger integrations ──────────────────────────────────────────
            if (ownerEmail) {
                const userSnap = await db.collection('users').doc(ownerEmail).get();
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

            // ── Confirmation message — matches the design image exactly ───────
            const answer =
`✅ APPOINTMENT BOOKED

NAME:       ${userName}
CONTACT:    ${contactInfo}
DATE:       ${dateISO}
TIME:       ${appointmentTime}

Reply with "CANCEL" to cancel the appointment and "EDIT" to change a detail.`;

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
        return res.status(500).json({ success: false, answer: 'Something went wrong. Please try again.', reply: 'Something went wrong.' });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// 5. ROI
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
// 6. WHATSAPP VERIFY
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
                message: 'WhatsApp not configured. Add WA_BUSINESS_PHONE_NUMBER_ID + WA_ACCESS_TOKEN OR Twilio credentials to Vercel environment variables.'
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
                    message: `Your WhatsApp number hasn't joined the Twilio sandbox. Send "join <your-keyword>" to ${from} on WhatsApp first, then try again.`
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
// 7. WHATSAPP CONFIRM
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
// 8. GOOGLE OAUTH — initiate
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
// 9. GOOGLE OAUTH — callback
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

        console.log('[OAuth/Google] Saved tokens for:', email);

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
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Resolve any natural-language date string to YYYY-MM-DD
 */
function resolveDay(dayName) {
    if (!dayName) return new Date().toISOString().split('T')[0];
    const input = dayName.trim();
    const lower = input.toLowerCase();

    if (lower === 'today')    return new Date().toISOString().split('T')[0];
    if (lower === 'tomorrow') { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0]; }

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
            const d = new Date(year, mon, day, 12, 0, 0);
            if (!dmyMatch[3] && d < new Date()) d.setFullYear(d.getFullYear() + 1);
            return d.toISOString().split('T')[0];
        }
    }

    // "june 19", "june 19 2026"
    const mdyMatch = lower.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/);
    if (mdyMatch) {
        const mon  = months[mdyMatch[1]];
        const day  = parseInt(mdyMatch[2], 10);
        const year = mdyMatch[3] ? parseInt(mdyMatch[3], 10) : new Date().getFullYear();
        if (mon !== undefined) {
            const d = new Date(year, mon, day, 12, 0, 0);
            if (!mdyMatch[3] && d < new Date()) d.setFullYear(d.getFullYear() + 1);
            return d.toISOString().split('T')[0];
        }
    }

    // Native Date parse fallback
    const dateAttempt = new Date(input + (input.match(/\d/) && !input.includes(':') ? 'T12:00:00' : ''));
    if (!isNaN(dateAttempt.getTime())) return dateAttempt.toISOString().split('T')[0];

    // Weekday names
    const days    = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const cleaned = lower.replace(/^next\s+/, '').trim();
    const target  = days.indexOf(cleaned);
    if (target !== -1) {
        const today = new Date();
        let diff = target - today.getDay();
        if (diff <= 0) diff += 7;
        const d = new Date(today);
        d.setDate(today.getDate() + diff);
        return d.toISOString().split('T')[0];
    }

    return new Date().toISOString().split('T')[0];
}

/**
 * Parse a time string to { h, min } — strict, no silent defaults.
 * Returns null if the time string is not recognisable, so the caller
 * can ask the user again instead of silently using 09:00.
 */
function parseTime(timeStr) {
    if (!timeStr) return null;
    const s = timeStr.trim().toLowerCase();

    // Named periods → sensible midpoints
    if (s === 'morning')              return { h: 9,  min: 0 };
    if (s === 'afternoon')            return { h: 14, min: 0 };
    if (s === 'evening')              return { h: 18, min: 0 };
    if (s === 'noon' || s === 'midday') return { h: 12, min: 0 };
    if (s === 'midnight')             return { h: 0,  min: 0 };

    // "3 pm", "3:30pm", "3:30 pm", "15:00"
    const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (m) {
        let h   = parseInt(m[1], 10);
        const min = parseInt(m[2] || '0', 10);
        if (m[3] === 'pm' && h !== 12) h += 12;
        if (m[3] === 'am' && h === 12) h  = 0;
        if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return { h, min };
    }

    return null; // unrecognised — caller must ask again
}

/**
 * Check if a time slot is available on Google Calendar.
 * Returns { available: true } or { available: false, suggestedTimes: ['10:00 AM', ...] }
 */
async function checkCalendarAvailability(googleAuth, dateISO, timeStr, ownerEmail, db) {
    try {
        let accessToken = googleAuth.access_token;

        // Refresh token if expired
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
                }
            }
        }

        const parsed = parseTime(timeStr);
        if (!parsed) return { available: true }; // can't parse — let it through

        const { h, min } = parsed;
        const start = new Date(`${dateISO}T${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:00Z`);
        const end   = new Date(start.getTime() + 60 * 60000); // check 1-hour window

        // Fetch all events on that day
        const dayStart = new Date(`${dateISO}T00:00:00Z`);
        const dayEnd   = new Date(`${dateISO}T23:59:59Z`);

        const r = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
            `timeMin=${dayStart.toISOString()}&timeMax=${dayEnd.toISOString()}&singleEvents=true&orderBy=startTime`,
            { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
        );

        if (!r.ok) {
            console.error('[Availability] Calendar fetch failed:', r.status);
            return { available: true }; // fail open
        }

        const data = await r.json();
        const events = data.items || [];

        // Check if the requested slot overlaps any event
        const isBooked = events.some(ev => {
            const evStart = new Date(ev.start?.dateTime || ev.start?.date);
            const evEnd   = new Date(ev.end?.dateTime   || ev.end?.date);
            return start < evEnd && end > evStart;
        });

        if (!isBooked) return { available: true };

        // Build booked times set for this day (30-min granularity)
        const bookedRanges = events.map(ev => ({
            start: new Date(ev.start?.dateTime || ev.start?.date),
            end:   new Date(ev.end?.dateTime   || ev.end?.date)
        }));

        // Find 3 available 30-min slots within business hours (9am–6pm)
        const suggestions = [];
        for (let slotH = 9; slotH < 18 && suggestions.length < 3; slotH++) {
            for (let slotM = 0; slotM < 60 && suggestions.length < 3; slotM += 30) {
                const slotStart = new Date(`${dateISO}T${String(slotH).padStart(2,'0')}:${String(slotM).padStart(2,'0')}:00Z`);
                const slotEnd   = new Date(slotStart.getTime() + 30 * 60000);

                const conflict = bookedRanges.some(b => slotStart < b.end && slotEnd > b.start);
                if (!conflict) {
                    // Format as "10:00 AM"
                    const displayH   = slotH % 12 === 0 ? 12 : slotH % 12;
                    const displayMin = String(slotM).padStart(2, '0');
                    const period     = slotH < 12 ? 'AM' : 'PM';
                    suggestions.push(`${displayH}:${displayMin} ${period}`);
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
 * Add event to Google Calendar using the exact time provided by the user.
 */
async function addCalendarEvent(googleAuth, appt, ownerEmail, db) {
    let accessToken = googleAuth.access_token;

    // Refresh token if expired
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

    // Parse the user's time — if unrecognisable, log and skip silently
    const parsed = parseTime(appt.appointmentTime);
    if (!parsed) {
        console.error(`[Calendar] Cannot parse time "${appt.appointmentTime}" — event NOT created.`);
        return;
    }

    const { h, min } = parsed;
    const start = new Date(`${appt.scheduledDate}T${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:00`);
    const end   = new Date(start.getTime() + 30 * 60000); // 30-minute appointment

    const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            summary:     `Appointment: ${appt.customerName}`,
            description: `Contact: ${appt.contactInfo}\nBooked via Comex AI`,
            start: { dateTime: start.toISOString(), timeZone: 'UTC' },
            end:   { dateTime: end.toISOString(),   timeZone: 'UTC' }
        })
    });

    const data = await r.json();
    if (!r.ok) console.error('[Calendar] Event error:', data.error?.message);
    else       console.log('[Calendar] Event created:', data.id, 'at', start.toISOString());
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
