// api/index.js - Single serverless function router for Vercel Hobby plan
// Routes: /api/chat, /api/config, /api/scrape, /api/deploy, /api/calculate-roi
//         /api/whatsapp-verify, /api/whatsapp-verify-confirm
//         /api/oauth/google, /api/oauth/google/callback

import admin from 'firebase-admin';
import Groq from 'groq-sdk';

// ─── Firebase Admin Singleton ────────────────────────────────────────────────
function getDb() {
    if (!admin.apps.length) {
        const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
        if (!b64) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON env var.');
        const sa = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
        admin.initializeApp({ credential: admin.credential.cert(sa) });
    }
    return admin.firestore();
}

// ─── CORS helper ─────────────────────────────────────────────────────────────
function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ─── Main Router ─────────────────────────────────────────────────────────────
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
// 1. DEPLOY — save bot to Firestore via Admin SDK (bypasses security rules)
// ════════════════════════════════════════════════════════════════════════════
async function handleDeploy(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { botData, ownerEmail } = req.body || {};
    if (!botData?.id || !botData?.name || !ownerEmail) {
        return res.status(400).json({ success: false, message: 'Missing botData.id, botData.name, or ownerEmail.' });
    }

    try {
        botData.owner     = ownerEmail;
        botData.deletedAt = null;
        botData.createdAt = botData.createdAt || new Date().toISOString();

        await getDb().collection('user_bots').doc(botData.id).set(botData, { merge: true });
        console.log('[Deploy] Saved bot:', botData.id);
        return res.status(200).json({ success: true, botId: botData.id });
    } catch (err) {
        console.error('[Deploy]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// 2. SCRAPE — fetch URL text and store in Firestore
// ════════════════════════════════════════════════════════════════════════════
async function handleScrape(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { businessId, url, customInstructions } = req.body || {};
    if (!businessId || !url) {
        return res.status(400).json({ success: false, message: 'Missing businessId or url.' });
    }

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
// 3. CONFIG — load bot settings for the widget
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
// 4. CHAT — AI responses + appointment booking
// FIX: Upgraded system prompt to PREVENT JSON leakage from llama-3.1-8b-instant
// FIX: tool_choice set to 'required' when all 4 fields are present in history
// ════════════════════════════════════════════════════════════════════════════
async function handleChat(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { businessId, message, question, history = [], conversationId: inId } = req.body || {};
    const userMsg = message || question;

    if (!businessId || !userMsg) {
        return res.status(400).json({ success: false, answer: 'Missing businessId or message.' });
    }
    if (!process.env.GROQ_API_KEY) {
        return res.status(500).json({ success: false, answer: 'GROQ_API_KEY not set in Vercel env vars.' });
    }

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
                sysPrompt = `You are a helpful assistant for "${botName}". Use this info to answer:\n\n${b.context}`;
            }
            if (kc.fileContents) {
                sysPrompt += `\n\n[UPLOADED DOCS]:\n${String(kc.fileContents).substring(0, 6000)}`;
            }
        }

        // ── CRITICAL FIX: Strict booking prompt prevents JSON leakage ──
        // llama-3.1-8b-instant sometimes prints tool call JSON as text instead
        // of invoking the tool. These rules stop that behaviour.
        sysPrompt += `

APPOINTMENT BOOKING RULES — FOLLOW EXACTLY:
1. Collect ONLY ONE piece of info per message: full name → contact (email or phone) → preferred day → preferred time. Ask them one at a time.
2. Once you have all 4 pieces, SILENTLY call the appointmentBooking tool. Do NOT print JSON, do NOT print the arguments, do NOT say "I have all the info". Just call the tool immediately.
3. NEVER output raw JSON, curly braces {}, or function arguments in your reply. That is a critical error.
4. NEVER re-ask for information already provided in the conversation history.
5. Accept flexible date/time formats: "Monday", "17 June", "3 pm", "3:00 PM", "next Tuesday" are all valid.
6. After the tool is called and booking is confirmed, reply with the confirmation message only.`;

        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const safeHistory = (Array.isArray(history) ? history : [])
            .slice(-10)
            .filter(m => m?.role && m?.content);

        // Detect if all 4 booking fields are already in history to force tool call
        const historyText = safeHistory.map(m => m.content).join(' ').toLowerCase();
        const hasName    = /my name is|i('m| am)|name[:\s]+[a-z]/i.test(historyText);
        const hasContact = /[@]|email|phone|number/i.test(historyText);
        const hasDay     = /monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}[\s\/\-]\w+/i.test(historyText);
        const hasTime    = /\d{1,2}(:\d{2})?\s*(am|pm)|morning|afternoon|evening|\d{1,2}\s*o'?clock/i.test(historyText);
        const allFieldsPresent = hasName && hasContact && hasDay && hasTime;

        const completion = await groq.chat.completions.create({
            model:       'llama-3.3-70b-versatile', // Upgraded: much better tool-calling than 8b-instant
            messages: [
                { role: 'system', content: sysPrompt },
                ...safeHistory,
                { role: 'user', content: userMsg }
            ],
            tools: [{
                type: 'function',
                function: {
                    name: 'appointmentBooking',
                    description: 'Call this function immediately and silently once you have collected: full name, contact info, appointment day, and appointment time. Do not print the arguments.',
                    parameters: {
                        type: 'object',
                        properties: {
                            userName:        { type: 'string', description: 'Full name of the customer' },
                            contactInfo:     { type: 'string', description: 'Email address or phone number' },
                            appointmentDay:  { type: 'string', description: 'Day or date of the appointment' },
                            appointmentTime: { type: 'string', description: 'Time of the appointment' }
                        },
                        required: ['userName', 'contactInfo', 'appointmentDay', 'appointmentTime']
                    }
                }
            }],
            // Force tool call when all fields are detected in history
            tool_choice:  allFieldsPresent ? { type: 'function', function: { name: 'appointmentBooking' } } : 'auto',
            temperature:  0.3, // Lower = less hallucination / JSON leakage
            max_tokens:   600
        });

        const choice = completion.choices[0]?.message;

        // ── SAFETY NET: catch JSON leakage in text reply and convert to tool call ──
        // If the model still prints raw JSON despite instructions, parse it ourselves
        if (choice?.content && !choice?.tool_calls) {
            const jsonMatch = choice.content.match(/\{[\s\S]*"userName"[\s\S]*"contactInfo"[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const leaked = JSON.parse(jsonMatch[0]);
                    if (leaked.userName && leaked.contactInfo && leaked.appointmentDay && leaked.appointmentTime) {
                        console.warn('[Chat] Intercepted leaked tool JSON, processing as booking');
                        // Treat it as a real tool call
                        choice.tool_calls = [{
                            function: {
                                name: 'appointmentBooking',
                                arguments: JSON.stringify(leaked)
                            }
                        }];
                        choice.content = null;
                    }
                } catch { /* not valid JSON, ignore */ }
            }
        }

        // ── Appointment tool call ──
        if (choice?.tool_calls?.[0]?.function?.name === 'appointmentBooking') {
            let args;
            try { args = JSON.parse(choice.tool_calls[0].function.arguments); }
            catch { return res.json({ success: true, answer: 'Could you confirm your booking details?' }); }

            const { userName, contactInfo, appointmentDay, appointmentTime } = args;
            if (!userName || !contactInfo || !appointmentDay || !appointmentTime) {
                return res.json({ success: true, answer: "I still need a few details. What's your name, contact info, preferred day and time?" });
            }

            const dateISO = resolveDay(appointmentDay);
            const appt = {
                businessId, botName, owner: ownerEmail, conversationId: convId,
                customerName: userName, contactInfo,
                appointmentDay, appointmentTime, scheduledDate: dateISO,
                status: 'confirmed', createdAt: new Date().toISOString()
            };

            await db.collection('appointments').add(appt);
            await db.collection('user_bots').doc(businessId).collection('appointments').add(appt);

            // Integrations
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

            const answer = `✅ Appointment Confirmed!\n\n📅 Date: ${dateISO}\n🕐 Time: ${appointmentTime}\n👤 Name: ${userName}\n📧 Contact: ${contactInfo}\n\nIs there anything else I can help you with?`;
            return res.json({ success: true, answer, reply: answer });
        }

        // ── Plain reply ──
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
// 5. CALCULATE ROI
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
        console.error('[ROI]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// 6. WHATSAPP VERIFY
// Supports BOTH:
//   A) WhatsApp Business API (Meta) — set WA_BUSINESS_PHONE_NUMBER_ID + WA_ACCESS_TOKEN
//   B) Twilio sandbox fallback       — set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_WHATSAPP_NUMBER
// ════════════════════════════════════════════════════════════════════════════
async function handleWAVerify(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { userEmail, phoneNumber } = req.body || {};
    if (!userEmail || !phoneNumber) {
        return res.status(400).json({ success: false, message: 'Missing userEmail or phoneNumber.' });
    }

    let to = phoneNumber.replace(/[\s\-\(\)]/g, '');
    if (!to.startsWith('+')) to = '+' + to;
    // WhatsApp Business API needs number without leading +
    const toWA = to.replace(/^\+/, '');

    const code      = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    try {
        await getDb().collection('whatsapp_verifications').doc(userEmail).set({
            verificationCode: code, phoneNumber: to, expiresAt, attempts: 0,
            createdAt: new Date().toISOString()
        });

        // ── Try WhatsApp Business API first ──
        const waPhoneId    = process.env.WA_BUSINESS_PHONE_NUMBER_ID;
        const waToken      = process.env.WA_ACCESS_TOKEN;

        if (waPhoneId && waToken) {
            const waRes = await fetch(
                `https://graph.facebook.com/v19.0/${waPhoneId}/messages`,
                {
                    method:  'POST',
                    headers: {
                        Authorization:  `Bearer ${waToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        messaging_product: 'whatsapp',
                        to: toWA,
                        type: 'text',
                        text: {
                            body: `Your Comex AI verification code is: *${code}*\n\nExpires in 10 minutes. Do not share this code.`
                        }
                    })
                }
            );
            const waData = await waRes.json();
            if (!waRes.ok) {
                console.error('[WA-Business]', JSON.stringify(waData));
                return res.status(500).json({
                    success: false,
                    message: waData.error?.message || 'WhatsApp Business API error. Check WA_BUSINESS_PHONE_NUMBER_ID and WA_ACCESS_TOKEN in Vercel.'
                });
            }
            console.log('[WA-Business] Code sent to', to, '| msg id:', waData.messages?.[0]?.id);
            return res.json({ success: true, message: `Code sent to ${to} via WhatsApp.`, provider: 'whatsapp-business' });
        }

        // ── Fallback: Twilio sandbox ──
        const sid   = process.env.TWILIO_ACCOUNT_SID;
        const token = process.env.TWILIO_AUTH_TOKEN;
        const from  = process.env.TWILIO_WHATSAPP_NUMBER;

        if (!sid || !token || !from) {
            return res.status(500).json({
                success: false,
                message: 'WhatsApp not configured. Add WA_BUSINESS_PHONE_NUMBER_ID + WA_ACCESS_TOKEN (recommended) OR TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_WHATSAPP_NUMBER to Vercel environment variables.'
            });
        }

        const twRes = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
            {
                method:  'POST',
                headers: {
                    Authorization:  `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    From: `whatsapp:${from}`,
                    To:   `whatsapp:${to}`,
                    Body: `Your Comex AI verification code is: *${code}*\n\nExpires in 10 minutes. Do not share.`
                })
            }
        );

        const twData = await twRes.json();
        if (!twRes.ok) {
            if (twData.code === 63016) {
                return res.status(400).json({
                    success: false, code: 'NOT_OPTED_IN',
                    message: `Your WhatsApp number hasn't joined the Twilio sandbox yet. Send "join <keyword>" to ${from} on WhatsApp first.`
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
// 7. WHATSAPP CONFIRM — validate code
// ════════════════════════════════════════════════════════════════════════════
async function handleWAConfirm(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { userEmail, verificationCode } = req.body || {};
    if (!userEmail || !verificationCode) {
        return res.status(400).json({ success: false, message: 'Missing userEmail or verificationCode.' });
    }

    try {
        const db   = getDb();
        const ref  = db.collection('whatsapp_verifications').doc(userEmail);
        const snap = await ref.get();

        if (!snap.exists) return res.status(404).json({ success: false, message: 'No pending verification. Please start again.' });

        const data = snap.data();
        if (Date.now() > new Date(data.expiresAt).getTime()) {
            await ref.delete();
            return res.status(400).json({ success: false, message: 'Code expired. Please request a new one.' });
        }

        const attempts = (data.attempts || 0) + 1;
        if (data.verificationCode !== verificationCode.trim()) {
            if (attempts >= 3) {
                await ref.delete();
                return res.status(400).json({ success: false, message: 'Too many attempts. Please start again.' });
            }
            await ref.update({ attempts });
            return res.status(400).json({ success: false, message: `Wrong code. ${3 - attempts} attempt(s) left.` });
        }

        await db.collection('users').doc(userEmail).set({
            integrations: {
                whatsappAlerts: {
                    connected:   true,
                    phoneNumber: data.phoneNumber,
                    verifiedAt:  new Date().toISOString()
                }
            }
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
    const { email } = req.query;
    if (!email) return res.status(400).send('Missing email.');

    const clientId    = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI ||
                        `https://${req.headers.host}/api/oauth/google/callback`;

    if (!clientId) return res.status(500).send('Missing GOOGLE_CLIENT_ID env var.');

    const state = Buffer.from(JSON.stringify({ email })).toString('base64');
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

    let email = '';
    try {
        email = JSON.parse(Buffer.from(state, 'base64').toString('utf-8')).email;
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
            method:  'POST',
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
                    // FIX: store absolute ISO timestamp, not relative seconds
                    expiry_date:   tokens.expires_in
                        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
                        : new Date(Date.now() + 3600 * 1000).toISOString() // default 1h
                }
            }
        }, { merge: true });

        console.log('[OAuth/Google] Saved tokens for:', email);

        const appUrl = process.env.APP_URL || 'https://cometchat-ai-platform.web.app';
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
 * Resolve a natural-language day/date string to ISO date YYYY-MM-DD
 * Handles: "Monday", "17 June", "17 June 2026", "next Tuesday", "tomorrow"
 */
function resolveDay(dayName) {
    if (!dayName) return new Date().toISOString().split('T')[0];
    const input = dayName.trim().toLowerCase();

    // "tomorrow"
    if (input === 'tomorrow') {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        return d.toISOString().split('T')[0];
    }

    // "today"
    if (input === 'today') return new Date().toISOString().split('T')[0];

    // Full or partial date: "17 june", "17 june 2026", "june 17", "june 17 2026"
    const dateAttempt = new Date(dayName);
    if (!isNaN(dateAttempt.getTime())) {
        // Parsed successfully — but shift to correct timezone (avoid UTC midnight rollback)
        const d = new Date(dayName + (dayName.includes(':') ? '' : 'T12:00:00'));
        if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    }

    // Weekday names: "monday", "next monday"
    const days   = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const cleaned = input.replace('next ', '').trim();
    const target  = days.indexOf(cleaned);
    if (target !== -1) {
        const today = new Date();
        let diff    = target - today.getDay();
        if (diff <= 0) diff += 7; // always next occurrence
        const d = new Date(today);
        d.setDate(today.getDate() + diff);
        return d.toISOString().split('T')[0];
    }

    // Fallback: today
    return new Date().toISOString().split('T')[0];
}

/**
 * Parse flexible time strings to { h, min }
 * Handles: "3 pm", "3:00 PM", "15:00", "3pm", "3", "morning" (→9), "afternoon" (→14), "evening" (→18)
 */
function parseTime(timeStr) {
    if (!timeStr) return { h: 9, min: 0 };
    const s = timeStr.trim().toLowerCase();

    // Natural language
    if (s === 'morning')   return { h: 9,  min: 0 };
    if (s === 'afternoon') return { h: 14, min: 0 };
    if (s === 'evening')   return { h: 18, min: 0 };
    if (s === 'noon' || s === 'midday') return { h: 12, min: 0 };

    // "3 pm", "3pm", "3:00 pm", "3:30pm", "15:00", "15:30"
    const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (m) {
        let h   = parseInt(m[1], 10);
        const min = parseInt(m[2] || '0', 10);
        const period = m[3];
        if (period === 'pm' && h !== 12) h += 12;
        if (period === 'am' && h === 12) h  = 0;
        return { h, min };
    }

    return { h: 9, min: 0 }; // safe fallback
}

async function addCalendarEvent(googleAuth, appt, ownerEmail, db) {
    let accessToken = googleAuth.access_token;

    // FIX: Guard against null expiry_date before comparing
    if (googleAuth.refresh_token && googleAuth.expiry_date) {
        const expiryMs = new Date(googleAuth.expiry_date).getTime();
        if (!isNaN(expiryMs) && expiryMs < Date.now() + 60000) {
            const r = await fetch('https://oauth2.googleapis.com/token', {
                method:  'POST',
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
                console.error('[Calendar/Refresh] No access_token in refresh response:', t);
            }
        }
    }

    // FIX: Use robust parseTime() instead of brittle regex that failed on "3 pm"
    const { h, min } = parseTime(appt.appointmentTime);

    const start = new Date(`${appt.scheduledDate}T${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:00`);
    const end   = new Date(start.getTime() + 30 * 60000);

    const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method:  'POST',
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

/**
 * Send WhatsApp appointment notification
 * Supports WhatsApp Business API (Meta) with Twilio fallback
 */
async function sendWANotification(waAuth, appt) {
    if (!waAuth.phoneNumber) return;

    let to = waAuth.phoneNumber.replace(/[\s\-\(\)]/g, '');
    if (!to.startsWith('+')) to = '+' + to;

    const body =
        `📅 *New Appointment Booked*\n\n` +
        `👤 Name: ${appt.customerName}\n` +
        `📧 Contact: ${appt.contactInfo}\n` +
        `📆 Date: ${appt.scheduledDate}\n` +
        `🕐 Time: ${appt.appointmentTime}\n\n` +
        `Booked via Comex AI`;

    // ── Try WhatsApp Business API first ──
    const waPhoneId = process.env.WA_BUSINESS_PHONE_NUMBER_ID;
    const waToken   = process.env.WA_ACCESS_TOKEN;

    if (waPhoneId && waToken) {
        const toWA = to.replace(/^\+/, '');
        const r = await fetch(
            `https://graph.facebook.com/v19.0/${waPhoneId}/messages`,
            {
                method:  'POST',
                headers: { Authorization: `Bearer ${waToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messaging_product: 'whatsapp',
                    to: toWA,
                    type: 'text',
                    text: { body }
                })
            }
        );
        if (!r.ok) {
            const d = await r.json();
            console.error('[WhatsApp-Business] Send error:', d.error?.message);
        } else {
            console.log('[WhatsApp-Business] Notification sent to', to);
        }
        return;
    }

    // ── Fallback: Twilio ──
    const sid   = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from  = process.env.TWILIO_WHATSAPP_NUMBER;
    if (!sid || !token || !from) return;

    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method:  'POST',
        headers: {
            Authorization:  `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ From: `whatsapp:${from}`, To: `whatsapp:${to}`, Body: body })
    });

    if (!r.ok) {
        const d = await r.json();
        console.error('[WhatsApp-Twilio] Send error:', d.message);
    } else {
        console.log('[WhatsApp-Twilio] Notification sent to', to);
    }
}
