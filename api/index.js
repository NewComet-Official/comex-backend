// api/index.js

import admin from 'firebase-admin';
import Groq from 'groq-sdk';

const YCLOUD_API_KEY    = process.env.YCLOUD_API_KEY || '';
const BOOKING_IMAGE_URL = 'https://i.ibb.co/8nbzHx0N/Appointment-booking-cofirmed.png';

// ── Prefilled WhatsApp message that opens the 24-hour session ────────────────
// Users send this FIRST before entering their number, so the window is always open.
const WA_PREFILL_TEXT = 'I want to connect WhatsApp Integration for my business on Comex AI platform.';
const WA_PREFILL_ENC  = encodeURIComponent(WA_PREFILL_TEXT);

// ════════════════════════════════════════════════════════════════════════════
// PHONE HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Normalise any phone string to strict E.164 (+digits only, no spaces).
 * Handles: +918318228754 / 918318228754 / +91 831 822 8754 / 08318228754
 */
function normalisePhone(raw) {
    if (!raw) return null;
    const str    = String(raw).trim();
    const digits = str.replace(/\D/g, '');
    if (digits.length < 7) return null;
    return '+' + digits;
}

/** True if the contact string looks like a phone number rather than an email. */
function looksLikePhone(contact) {
    if (!contact) return false;
    return !contact.includes('@') && contact.replace(/\D/g, '').length >= 7;
}

/**
 * Build the wa.me deep-link for a given FROM number (the YCloud sender number).
 * Strip '+' for the wa.me URL format.
 */
function buildWALink(fromNumber) {
    const digits = String(fromNumber || '').replace(/\D/g, '');
    if (!digits) return null;
    return `https://wa.me/${digits}?text=${WA_PREFILL_ENC}`;
}

/**
 * Build a QR-code image URL using the free api.qrserver.com service.
 */
function buildQRUrl(waLink) {
    if (!waLink) return null;
    return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(waLink)}`;
}

/**
 * Return { waLink, qrUrl } for the configured YCLOUD_FROM_NUMBER.
 * Returns { waLink: null, qrUrl: null } if not configured.
 */
function getSessionLinks() {
    const from = normalisePhone(process.env.YCLOUD_FROM_NUMBER);
    const waLink = from ? buildWALink(from) : null;
    const qrUrl  = waLink ? buildQRUrl(waLink) : null;
    return { waLink, qrUrl };
}

// ════════════════════════════════════════════════════════════════════════════
// FIREBASE
// ════════════════════════════════════════════════════════════════════════════

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

// ════════════════════════════════════════════════════════════════════════════
// ROUTER
// ════════════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();

    const path = req.url.split('?')[0].replace(/\/$/, '');

    if (path === '/api/chat')                     return handleChat(req, res);
    if (path === '/api/config')                   return handleConfig(req, res);
    if (path === '/api/scrape')                   return handleScrape(req, res);
    if (path === '/api/deploy')                   return handleDeploy(req, res);
    if (path === '/api/calculate-roi')            return handleROI(req, res);
    if (path === '/api/whatsapp-session-info')    return handleWASessionInfo(req, res);
    if (path === '/api/whatsapp-verify')          return handleWAVerify(req, res);
    if (path === '/api/whatsapp-verify-confirm')  return handleWAConfirm(req, res);
    if (path === '/api/oauth/google')             return handleGoogleOAuth(req, res);
    if (path === '/api/oauth/google/callback')    return handleGoogleCallback(req, res);

    return res.status(404).json({ success: false, message: `Unknown route: ${path}` });
}

// ════════════════════════════════════════════════════════════════════════════
// YCLOUD SEND HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Core YCloud send function.
 * Returns a structured result object instead of throwing, so callers can
 * handle specific error codes gracefully.
 *
 * Error codes we handle specifically:
 *   100    – Invalid parameter (also fires when you message your own YCloud number)
 *   131031 – Recipient's WhatsApp Business account restricted/deactivated by Meta
 *   131047 – Outside 24-hour conversation window (customer hasn't messaged first)
 *   470    – Re-engagement not permitted (another 24h-window variant)
 *
 * Returns:
 *   { sent: true, messageId }
 *   { sent: false, errorCode, reason, userFacingMessage }
 */
async function ycloudSend(to, type, typePayload) {
    const norm = normalisePhone(to);
    if (!norm) {
        return {
            sent: false,
            errorCode: 'INVALID_PHONE',
            reason: 'invalid_phone',
            userFacingMessage: 'The phone number format is invalid. Please include your country code (e.g. +91 9876543210).'
        };
    }

    if (!YCLOUD_API_KEY) {
        return { sent: false, errorCode: 'NO_API_KEY', reason: 'no_api_key', userFacingMessage: 'WhatsApp service not configured.' };
    }

    const FROM_NUMBER = normalisePhone(process.env.YCLOUD_FROM_NUMBER);
    if (!FROM_NUMBER) {
        return { sent: false, errorCode: 'NO_FROM', reason: 'no_from', userFacingMessage: 'WhatsApp sender number not configured.' };
    }

    // ── Error 100 prevention: YCloud does not allow messaging the same number
    // that owns the account (the FROM number). Detect and bail early.
    if (norm === FROM_NUMBER) {
        return {
            sent: false,
            errorCode: 100,
            reason: 'self_message',
            userFacingMessage: `You cannot send WhatsApp notifications to the same number used to create your YCloud account (${norm}). Please use a different phone number.`
        };
    }

    const body = { from: FROM_NUMBER, to: norm, type, ...typePayload };
    console.log('[YCloud] Sending', type, 'from', FROM_NUMBER, 'to', norm);

    try {
        const r = await fetch('https://api.ycloud.com/v2/whatsapp/messages', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': YCLOUD_API_KEY },
            body: JSON.stringify(body)
        });

        const data = await r.json();

        if (!r.ok) {
            const errorCode = Number(data.error?.code || data.code || 0);
            console.error('[YCloud] Error', errorCode, JSON.stringify(data));

            // ── 24-hour window closed ─────────────────────────────────────────
            const is24h = [131047, 470, 368].includes(errorCode) ||
                          /window|session|24.hour|outside/i.test(data.message || '');
            if (is24h) {
                return {
                    sent: false,
                    errorCode,
                    reason: '24h_window',
                    userFacingMessage: null // caller will show QR card instead
                };
            }

            // ── Recipient account restricted/deactivated ──────────────────────
            if (errorCode === 131031) {
                return {
                    sent: false,
                    errorCode,
                    reason: 'account_restricted',
                    userFacingMessage: 'This WhatsApp number\'s Business account has been restricted or deactivated by Meta. Please use a personal WhatsApp number or a different Business number that is in good standing.'
                };
            }

            // ── Generic error 100 (invalid parameter) ─────────────────────────
            // Remaining 100 errors after self-message check are usually the recipient
            // number not being on WhatsApp, or a malformed number.
            if (errorCode === 100) {
                return {
                    sent: false,
                    errorCode,
                    reason: 'invalid_param',
                    userFacingMessage: 'The phone number doesn\'t appear to be registered on WhatsApp, or is invalid. Please double-check the number and country code.'
                };
            }

            return {
                sent: false,
                errorCode,
                reason: 'api_error',
                userFacingMessage: data.message || 'WhatsApp message could not be delivered.'
            };
        }

        console.log('[YCloud] Sent to', norm, '→ id:', data.id);
        return { sent: true, messageId: data.id };

    } catch (err) {
        console.error('[YCloud] Network error:', err.message);
        return { sent: false, errorCode: 'NETWORK', reason: 'network', userFacingMessage: 'Network error contacting WhatsApp service.' };
    }
}

/** Convenience: send a text message. */
async function sendWAText(to, bodyText) {
    return ycloudSend(to, 'text', { text: { body: bodyText } });
}

/** Convenience: send an image + caption message. */
async function sendWAImage(to, caption) {
    return ycloudSend(to, 'image', { image: { link: BOOKING_IMAGE_URL, caption } });
}

/** Build the booking confirmation caption. */
function buildBookingCaption(appt) {
    return (
        `*APPOINTMENT BOOKED*\n\n` +
        `Name: ${appt.customerName}\n` +
        `Contact: ${appt.contactInfo}\n` +
        `Date: ${appt.scheduledDate}\n` +
        `Time: ${appt.appointmentTime}\n\n` +
        `Team Comex`
    );
}

// ════════════════════════════════════════════════════════════════════════════
// NEW ROUTE: GET /api/whatsapp-session-info
// Returns the wa.me link + QR URL for the frontend to display BEFORE the user
// enters their phone number. When they send the prefilled message, the 24-hour
// session opens and OTP delivery is guaranteed.
// ════════════════════════════════════════════════════════════════════════════
async function handleWASessionInfo(req, res) {
    const { waLink, qrUrl } = getSessionLinks();
    if (!waLink) {
        return res.status(500).json({ success: false, message: 'YCLOUD_FROM_NUMBER not configured.' });
    }
    return res.json({
        success: true,
        waLink,
        qrUrl,
        prefillText: WA_PREFILL_TEXT
    });
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
        await getDb().collection('user_bots').doc(botData.id).set(botData, { merge: true });
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
        let sysPrompt  = 'You are a helpful, friendly customer service assistant.';
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

        const hasName = (
            /my name is|i am|i'm|it'?s\s+[a-z]+|name[:\s]+/i.test(allText) ||
            safeHistory.some(m => m.role === 'user' && /^[A-Z][a-z]+ [A-Z][a-z]+/.test(m.content.trim()))
        );
        const hasContact = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/.test(allText) ||
                           /(\+?\d[\d\s\-]{6,}\d)/.test(allText);
        const hasDay  = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}[\s\/\-](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}))\b/i.test(allTextLow);
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

        // Safety net: catch leaked JSON
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

            // Availability check (Google Calendar)
            if (ownerEmail) {
                const userSnap     = await db.collection('users').doc(ownerEmail).get();
                const integrations = userSnap.exists ? (userSnap.data()?.integrations || {}) : {};
                if (integrations.google_calendar?.connected) {
                    const avail = await checkCalendarAvailability(
                        integrations.google_calendar, dateISO, appointmentTime, ownerEmail, db
                    );
                    if (!avail.available) {
                        const alts = avail.suggestedTimes || [];
                        const altText = alts.length > 0
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

            // Save appointment record
            const appt = {
                businessId, botName, owner: ownerEmail, conversationId: convId,
                customerName: userName, contactInfo,
                appointmentDay, appointmentTime, scheduledDate: dateISO,
                status: 'confirmed', createdAt: new Date().toISOString()
            };

            await db.collection('appointments').add(appt);
            await db.collection('user_bots').doc(businessId).collection('appointments').add(appt);

            // Google Calendar event
            if (ownerEmail) {
                const userSnap     = await db.collection('users').doc(ownerEmail).get();
                const integrations = userSnap.exists ? (userSnap.data()?.integrations || {}) : {};
                if (integrations.google_calendar?.connected) {
                    try { await addCalendarEvent(integrations.google_calendar, appt, ownerEmail, db); }
                    catch (e) { console.error('[Chat/Calendar]', e.message); }
                }
            }

            // WhatsApp notifications (fire-and-forget — don't block the chat response)
            const caption = buildBookingCaption(appt);
            let waSessionRequired = false;
            const { waLink, qrUrl } = getSessionLinks();

            // Notify the owner
            if (ownerEmail) {
                try {
                    const userSnap     = await db.collection('users').doc(ownerEmail).get();
                    const integrations = userSnap.exists ? (userSnap.data()?.integrations || {}) : {};
                    const ownerPhone   = integrations.whatsappAlerts?.phoneNumber;
                    if (ownerPhone) {
                        const result = await sendWAImage(ownerPhone, caption);
                        if (!result.sent && result.reason === '24h_window') waSessionRequired = true;
                        if (!result.sent) console.warn('[WA] Owner notify failed:', result.reason, result.userFacingMessage);
                    }
                } catch (e) { console.error('[WA] Owner error:', e.message); }
            }

            // Notify the customer if they gave a phone number
            if (looksLikePhone(contactInfo)) {
                try {
                    const result = await sendWAImage(contactInfo, caption);
                    if (!result.sent && result.reason === '24h_window') waSessionRequired = true;
                    if (!result.sent) console.warn('[WA] Customer notify failed:', result.reason, result.userFacingMessage);
                } catch (e) { console.error('[WA] Customer error:', e.message); }
            }

            // Log chat
            await db.collection('user_bots').doc(businessId).collection('chats').add({
                conversationId: convId, question: userMsg,
                answer: 'Appointment booked.', isGenuineQuery: true, isLeadCaptured: true,
                createdAt: new Date().toISOString()
            });

            // Build confirmation reply
            const pad = (label) => label.padEnd(8);
            const answer = [
                '✅ APPOINTMENT BOOKED',
                '',
                `${pad('NAME:')}    ${userName}`,
                `${pad('CONTACT:')} ${contactInfo}`,
                `${pad('DATE:')}    ${dateISO}`,
                `${pad('TIME:')}    ${appointmentTime}`,
                '',
                'Reply with "CANCEL" to cancel or "EDIT" to change a detail.'
            ].join('\n');

            return res.json({
                success: true, answer, reply: answer,
                // Signal the widget to show the QR card if the WA session was closed
                ...(waSessionRequired ? { waSessionRequired: true, waLink, qrUrl } : {})
            });
        }

        // Plain reply
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
// Flow: user has ALREADY sent the prefilled wa.me message (opening the 24h
// session), then enters their number here. We send the OTP immediately.
//
// Error handling:
//   self_message    → clear error: can't use your own YCloud number
//   account_restricted (131031) → clear error: use personal WA number
//   24h_window      → shouldn't happen since they sent first, but handled
//   invalid_param (100) → number not on WA or invalid
// ════════════════════════════════════════════════════════════════════════════
async function handleWAVerify(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { userEmail, phoneNumber } = req.body || {};
    if (!userEmail || !phoneNumber)
        return res.status(400).json({ success: false, message: 'Missing userEmail or phoneNumber.' });

    const norm = normalisePhone(phoneNumber);
    if (!norm)
        return res.status(400).json({
            success: false,
            message: 'Invalid phone number format. Please include your country code (e.g. +91 9876543210).'
        });

    const code      = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    try {
        await getDb().collection('whatsapp_verifications').doc(userEmail).set({
            verificationCode: code,
            phoneNumber:      norm,
            expiresAt,
            attempts:  0,
            createdAt: new Date().toISOString()
        });

        const otpText =
            `🔐 *Comex AI Verification*\n\n` +
            `Your verification code is:\n\n*${code}*\n\n` +
            `Expires in 10 minutes. Do not share it.\n\nTeam Comex`;

        const result = await sendWAText(norm, otpText);

        if (!result.sent) {
            // Map each error reason to a clear, actionable message
            let message;
            const { waLink, qrUrl } = getSessionLinks();

            switch (result.reason) {
                case 'self_message':
                    message = result.userFacingMessage;
                    return res.status(400).json({ success: false, message });

                case 'account_restricted':
                    message = result.userFacingMessage;
                    return res.status(400).json({ success: false, message });

                case '24h_window':
                    // This should be rare since the user sent the prefill first,
                    // but handle gracefully by showing the QR again.
                    return res.status(200).json({
                        success: false,
                        sessionRequired: true,
                        waLink,
                        qrUrl,
                        message: 'It looks like the WhatsApp session expired. Please scan the QR or use the link to send us a quick message first, then try again.'
                    });

                case 'invalid_param':
                    message = result.userFacingMessage;
                    return res.status(400).json({ success: false, message });

                default:
                    message = result.userFacingMessage || 'WhatsApp message could not be delivered. Please check the number and try again.';
                    return res.status(500).json({ success: false, message });
            }
        }

        return res.json({ success: true, message: `Verification code sent to ${norm} via WhatsApp.` });

    } catch (err) {
        console.error('[WA-Verify]', err.message);
        return res.status(500).json({ success: false, message: `Server error: ${err.message}` });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// WHATSAPP CONFIRM — validates the OTP
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

        // Save verified number
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

        // Send a welcome message — the 24h session should still be open
        const welcomeText =
            `✅ *WhatsApp Connected!*\n\n` +
            `Your number is now linked to Comex AI. ` +
            `You will receive appointment booking notifications here.\n\nTeam Comex`;

        const wResult = await sendWAText(data.phoneNumber, welcomeText);
        if (!wResult.sent) {
            console.warn('[WA-Confirm] Welcome message not delivered (non-fatal):', wResult.reason);
        }

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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
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
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

function resolveDay(dayName) {
    if (!dayName) {
        const n = new Date();
        return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
    }
    const input = dayName.trim();
    const lower = input.toLowerCase();
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

    if (lower === 'today')    return fmt(new Date());
    if (lower === 'tomorrow') { const d = new Date(); d.setDate(d.getDate()+1); return fmt(d); }

    const months = {
        january:0, february:1, march:2, april:3, may:4, june:5,
        july:6, august:7, september:8, october:9, november:10, december:11,
        jan:0, feb:1, mar:2, apr:3, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11
    };

    const dmy = lower.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:\s+(\d{4}))?$/);
    if (dmy) {
        const day = parseInt(dmy[1], 10), mon = months[dmy[2]];
        const year = dmy[3] ? parseInt(dmy[3], 10) : new Date().getFullYear();
        if (mon !== undefined) {
            const d = new Date(year, mon, day);
            if (!dmy[3] && d < new Date()) d.setFullYear(d.getFullYear()+1);
            return fmt(d);
        }
    }

    const mdy = lower.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/);
    if (mdy) {
        const mon = months[mdy[1]], day = parseInt(mdy[2], 10);
        const year = mdy[3] ? parseInt(mdy[3], 10) : new Date().getFullYear();
        if (mon !== undefined) {
            const d = new Date(year, mon, day);
            if (!mdy[3] && d < new Date()) d.setFullYear(d.getFullYear()+1);
            return fmt(d);
        }
    }

    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const cleaned = lower.replace(/^next\s+/, '').trim();
    const target  = days.indexOf(cleaned);
    if (target !== -1) {
        const today = new Date();
        let diff = target - today.getDay();
        if (diff <= 0) diff += 7;
        const d = new Date(today); d.setDate(today.getDate()+diff);
        return fmt(d);
    }

    const attempt = new Date(input.includes('T') ? input : `${input}T12:00:00`);
    if (!isNaN(attempt.getTime())) return fmt(attempt);
    return fmt(new Date());
}

function parseTime(timeStr) {
    if (!timeStr) return null;
    const s = timeStr.trim().toLowerCase();
    if (s === 'morning')                return { h: 9,  min: 0 };
    if (s === 'afternoon')              return { h: 14, min: 0 };
    if (s === 'evening')                return { h: 18, min: 0 };
    if (s === 'noon' || s === 'midday') return { h: 12, min: 0 };
    if (s === 'midnight')               return { h: 0,  min: 0 };
    const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (m) {
        let h = parseInt(m[1], 10);
        const min = parseInt(m[2] || '0', 10);
        if (m[3] === 'pm' && h !== 12) h += 12;
        if (m[3] === 'am' && h === 12) h  = 0;
        if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return { h, min };
    }
    return null;
}

async function getCalendarTimezone(accessToken) {
    try {
        const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary',
            { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!r.ok) return 'UTC';
        return (await r.json()).timeZone || 'UTC';
    } catch { return 'UTC'; }
}

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
            } else console.error('[Calendar/Refresh] Failed:', t);
        }
    }
    return accessToken;
}

async function checkCalendarAvailability(googleAuth, dateISO, timeStr, ownerEmail, db) {
    try {
        const accessToken = await refreshTokenIfNeeded(googleAuth, ownerEmail, db);
        const timeZone    = await getCalendarTimezone(accessToken);
        const parsed      = parseTime(timeStr);
        if (!parsed) return { available: true };

        const { h, min } = parsed;
        const localStart = `${dateISO}T${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:00`;
        const endH = h + Math.floor((min+60)/60), endMin = (min+60)%60;
        const localEnd = `${dateISO}T${String(endH).padStart(2,'0')}:${String(endMin).padStart(2,'0')}:00`;

        const toUTC = (localStr, tz) => {
            const naive = new Date(localStr + 'Z');
            const fmt   = new Intl.DateTimeFormat('en-CA', {
                timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit',
                hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
            });
            const parts = fmt.formatToParts(naive);
            const get   = type => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
            const tzH   = get('hour') === 24 ? 0 : get('hour');
            const repr  = Date.UTC(get('year'), get('month')-1, get('day'), tzH, get('minute'), get('second'));
            return new Date(naive.getTime() - (repr - naive.getTime()));
        };

        const startUTC    = toUTC(localStart, timeZone);
        const endUTC      = toUTC(localEnd,   timeZone);
        const dayStartUTC = toUTC(`${dateISO}T00:00:00`, timeZone);
        const dayEndUTC   = toUTC(`${dateISO}T23:59:59`, timeZone);

        const r = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
            `timeMin=${dayStartUTC.toISOString()}&timeMax=${dayEndUTC.toISOString()}&singleEvents=true&orderBy=startTime`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!r.ok) return { available: true };

        const events = (await r.json()).items || [];
        const isBooked = events.some(ev => {
            const evS = new Date(ev.start?.dateTime || ev.start?.date);
            const evE = new Date(ev.end?.dateTime   || ev.end?.date);
            return startUTC < evE && endUTC > evS;
        });
        if (!isBooked) return { available: true };

        const booked = events.map(ev => ({
            start: new Date(ev.start?.dateTime || ev.start?.date),
            end:   new Date(ev.end?.dateTime   || ev.end?.date)
        }));
        const suggestions = [];
        for (let sh = 9; sh < 18 && suggestions.length < 3; sh++) {
            for (let sm = 0; sm < 60 && suggestions.length < 3; sm += 30) {
                const sStr = `${dateISO}T${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}:00`;
                const sUTC = toUTC(sStr, timeZone);
                const eUTC = new Date(sUTC.getTime() + 30*60000);
                if (!booked.some(b => sUTC < b.end && eUTC > b.start)) {
                    const dh = sh%12 === 0 ? 12 : sh%12;
                    suggestions.push(`${dh}:${String(sm).padStart(2,'0')} ${sh < 12 ? 'AM' : 'PM'}`);
                }
            }
        }
        return { available: false, suggestedTimes: suggestions };

    } catch (err) {
        console.error('[Availability]', err.message);
        return { available: true };
    }
}

async function addCalendarEvent(googleAuth, appt, ownerEmail, db) {
    const accessToken = await refreshTokenIfNeeded(googleAuth, ownerEmail, db);
    const parsed = parseTime(appt.appointmentTime);
    if (!parsed) {
        console.error(`[Calendar] Cannot parse time "${appt.appointmentTime}" — skipping.`);
        return;
    }
    const { h, min } = parsed;
    const timeZone   = await getCalendarTimezone(accessToken);
    const localStart = `${appt.scheduledDate}T${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:00`;
    const endH = h + Math.floor((min+30)/60), endMin = (min+30)%60;
    const localEnd = `${appt.scheduledDate}T${String(endH).padStart(2,'0')}:${String(endMin).padStart(2,'0')}:00`;

    const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            summary:     `Appointment: ${appt.customerName}`,
            description: `Contact: ${appt.contactInfo}\nBooked via Comex AI`,
            start: { dateTime: localStart, timeZone },
            end:   { dateTime: localEnd,   timeZone }
        })
    });
    const data = await r.json();
    if (!r.ok) console.error('[Calendar] Event error:', data.error?.message);
    else       console.log('[Calendar] Event created:', data.id, 'at', localStart, timeZone);
}
