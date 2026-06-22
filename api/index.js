// api/index.js

import admin from 'firebase-admin';
import Groq from 'groq-sdk';

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

function getMessaging() {
    if (!admin.apps.length) getDb();
    return admin.messaging();
}

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ════════════════════════════════════════════════════════════════════════════
// MULTI-MODEL LLM ROUTER
// ════════════════════════════════════════════════════════════════════════════

/**
 * All models are served via Groq's unified API.
 * Model IDs map to Groq-hosted open-source models.
 * https://console.groq.com/docs/models
 */
const MODEL_REGISTRY = {
    // Meta LLaMA (default)
    'llama-3.3-70b':        { id: 'llama-3.3-70b-versatile',        provider: 'groq', label: 'Meta LLaMA 3.3 70B' },
    'llama-3.1-8b':         { id: 'llama-3.1-8b-instant',            provider: 'groq', label: 'Meta LLaMA 3.1 8B (Fast)' },
    // Google DeepMind Gemma
    'gemma-3-27b':          { id: 'gemma2-9b-it',                    provider: 'groq', label: 'Google Gemma 2 9B' },
    // Mistral AI
    'mistral-saba':         { id: 'mistral-saba-24b',                provider: 'groq', label: 'Mistral Saba 24B' },
    // Alibaba Qwen
    'qwen-3-32b':           { id: 'qwen-qwq-32b',                   provider: 'groq', label: 'Alibaba Qwen QwQ 32B' },
    // xAI Grok (via Groq — uses distil variant available on Groq)
    'groq-llama-tool':      { id: 'llama3-groq-70b-8192-tool-use-preview', provider: 'groq', label: 'Tool-Optimized LLaMA 70B' },
    // OpenAI-compatible GPT open weights (placeholder — swap id when available)
    'openai-gpt4o-mini':    { id: 'llama-3.3-70b-versatile',        provider: 'groq', label: 'GPT-4o Mini Compatible (LLaMA)' },
};

const DEFAULT_MODEL_KEY = 'llama-3.3-70b';

/**
 * Get the Groq model ID to use for a given bot config.
 * Falls back to default if the model key is unknown.
 */
function resolveModelId(modelKey) {
    const entry = MODEL_REGISTRY[modelKey] || MODEL_REGISTRY[DEFAULT_MODEL_KEY];
    return entry.id;
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
    if (path === '/api/models')                   return handleModels(req, res);
    if (path === '/api/fcm-register-token')       return handleFCMRegisterToken(req, res);
    if (path === '/api/fcm-remove-token')         return handleFCMRemoveToken(req, res);
    if (path === '/api/fcm-test-notification')    return handleFCMTestNotification(req, res);
    if (path === '/api/appointment/cancel')       return handleAppointmentCancel(req, res);
    if (path === '/api/appointment/edit')         return handleAppointmentEdit(req, res);
    if (path === '/api/oauth/google')             return handleGoogleOAuth(req, res);
    if (path === '/api/oauth/google/callback')    return handleGoogleCallback(req, res);

    return res.status(404).json({ success: false, message: `Unknown route: ${path}` });
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/models — returns available model options for the frontend
// ════════════════════════════════════════════════════════════════════════════
async function handleModels(req, res) {
    const models = Object.entries(MODEL_REGISTRY).map(([key, val]) => ({
        key,
        label: val.label,
        provider: val.provider
    }));
    return res.json({ success: true, models });
}

// ════════════════════════════════════════════════════════════════════════════
// FCM — PUSH NOTIFICATION HELPERS
// ════════════════════════════════════════════════════════════════════════════

async function sendFCMToUser(ownerEmail, { title, body, url, tag }) {
    if (!ownerEmail) return { sent: 0, failed: 0 };

    const db = getDb();
    const userRef = db.collection('users').doc(ownerEmail);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return { sent: 0, failed: 0 };

    const tokens = userSnap.data()?.fcmTokens || [];
    if (!tokens.length) return { sent: 0, failed: 0 };

    const messaging = getMessaging();
    const message = {
        tokens,
        data: {
            title: title || 'Comex AI Notification',
            body:  body  || '',
            url:   url   || '/',
            tag:   tag   || 'comex-general'
        },
        webpush: {
            fcmOptions: { link: url || '/' }
        }
    };

    let result;
    try {
        result = await messaging.sendEachForMulticast(message);
    } catch (err) {
        console.error('[FCM] sendEachForMulticast failed:', err.message);
        return { sent: 0, failed: tokens.length };
    }

    const deadTokens = [];
    result.responses.forEach((r, i) => {
        if (!r.success) {
            const code = r.error?.code || '';
            if (
                code === 'messaging/registration-token-not-registered' ||
                code === 'messaging/invalid-registration-token'
            ) {
                deadTokens.push(tokens[i]);
            }
        }
    });

    if (deadTokens.length) {
        const remaining = tokens.filter(t => !deadTokens.includes(t));
        await userRef.update({ fcmTokens: remaining });
    }

    return { sent: result.successCount, failed: result.failureCount };
}

function buildBookingNotification(appt) {
    return {
        title: '📅 New Appointment Booked!',
        body:  `${appt.customerName} booked ${appt.appointmentDay} at ${appt.appointmentTime}. Contact: ${appt.contactInfo}`,
        url:   '/?view=analytics',
        tag:   'comex-appointment'
    };
}

function buildCancellationNotification(appt) {
    return {
        title: '❌ Appointment Cancelled',
        body:  `APPOINTMENT CANCELLED\nAppointment booked on ${appt.scheduledDate} at ${appt.appointmentTime} by ${appt.customerName} has been cancelled by the client itself`,
        url:   '/?view=analytics',
        tag:   'comex-appointment-cancel'
    };
}

function buildEditNotification(appt, field, oldData, newData) {
    const fieldLabels = {
        customerName:    'name',
        contactInfo:     'contact info',
        appointmentDay:  'date',
        appointmentTime: 'time',
        scheduledDate:   'date'
    };
    const label = fieldLabels[field] || field;
    return {
        title: '✏️ Appointment Edited',
        body:  `APPOINTMENT EDITED\n${appt.customerName} edited the ${label} from "${oldData}" to "${newData}"`,
        url:   '/?view=analytics',
        tag:   'comex-appointment-edit'
    };
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/appointment/cancel
// Called by the chat handler when user confirms cancellation.
// ════════════════════════════════════════════════════════════════════════════
async function handleAppointmentCancel(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { appointmentId, businessId, ownerEmail } = req.body || {};
    if (!appointmentId || !businessId)
        return res.status(400).json({ success: false, message: 'Missing appointmentId or businessId.' });

    try {
        const db = getDb();

        // Mark as cancelled in global appointments
        const apptRef = db.collection('appointments').doc(appointmentId);
        const apptSnap = await apptRef.get();

        if (!apptSnap.exists) {
            return res.status(404).json({ success: false, message: 'Appointment not found.' });
        }

        const appt = apptSnap.data();
        await apptRef.update({ status: 'cancelled', cancelledAt: new Date().toISOString() });

        // Also mark cancelled in bot sub-collection (best-effort, find by conversationId)
        const botApptsRef = db.collection('user_bots').doc(businessId).collection('appointments');
        const q = await botApptsRef.where('conversationId', '==', appt.conversationId).get();
        q.forEach(d => d.ref.update({ status: 'cancelled', cancelledAt: new Date().toISOString() }));

        // Google Calendar: delete the event if we have it
        if (appt.googleCalendarEventId && ownerEmail) {
            try {
                const userSnap = await db.collection('users').doc(ownerEmail).get();
                const googleAuth = userSnap.data()?.integrations?.google_calendar;
                if (googleAuth?.connected) {
                    const token = await refreshTokenIfNeeded(googleAuth, ownerEmail, db);
                    await fetch(
                        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${appt.googleCalendarEventId}`,
                        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
                    );
                }
            } catch (e) {
                console.error('[Cancel/Calendar]', e.message);
            }
        }

        // Send push notification
        const notifyEmail = ownerEmail || appt.owner;
        if (notifyEmail) {
            await sendFCMToUser(notifyEmail, buildCancellationNotification(appt));
        }

        return res.json({ success: true, message: 'Appointment cancelled.' });
    } catch (err) {
        console.error('[AppointmentCancel]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/appointment/edit
// ════════════════════════════════════════════════════════════════════════════
async function handleAppointmentEdit(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { appointmentId, businessId, ownerEmail, field, newValue } = req.body || {};
    if (!appointmentId || !field || newValue === undefined)
        return res.status(400).json({ success: false, message: 'Missing required fields.' });

    // Only allow editing safe fields
    const EDITABLE_FIELDS = ['customerName', 'contactInfo', 'appointmentDay', 'appointmentTime', 'scheduledDate'];
    if (!EDITABLE_FIELDS.includes(field))
        return res.status(400).json({ success: false, message: `Field "${field}" is not editable.` });

    try {
        const db = getDb();
        const apptRef = db.collection('appointments').doc(appointmentId);
        const apptSnap = await apptRef.get();

        if (!apptSnap.exists)
            return res.status(404).json({ success: false, message: 'Appointment not found.' });

        const appt = apptSnap.data();
        const oldValue = appt[field] || '(not set)';

        // If editing date, resolve it
        let resolvedValue = newValue;
        if (field === 'appointmentDay') {
            resolvedValue = newValue;
            const iso = resolveDay(newValue);
            await apptRef.update({ [field]: newValue, scheduledDate: iso, updatedAt: new Date().toISOString() });
        } else {
            await apptRef.update({ [field]: resolvedValue, updatedAt: new Date().toISOString() });
        }

        // Update bot sub-collection too
        if (businessId) {
            const botApptsRef = db.collection('user_bots').doc(businessId).collection('appointments');
            const q = await botApptsRef.where('conversationId', '==', appt.conversationId).get();
            q.forEach(d => d.ref.update({ [field]: resolvedValue, updatedAt: new Date().toISOString() }));
        }

        // Google Calendar: update event if date or time changed
        if ((field === 'appointmentDay' || field === 'appointmentTime') && appt.googleCalendarEventId) {
            const notifyEmail = ownerEmail || appt.owner;
            if (notifyEmail) {
                try {
                    const userSnap = await db.collection('users').doc(notifyEmail).get();
                    const googleAuth = userSnap.data()?.integrations?.google_calendar;
                    if (googleAuth?.connected) {
                        const updatedAppt = { ...appt, [field]: resolvedValue };
                        if (field === 'appointmentDay') updatedAppt.scheduledDate = resolveDay(resolvedValue);
                        await updateCalendarEvent(googleAuth, appt.googleCalendarEventId, updatedAppt, notifyEmail, db);
                    }
                } catch (e) {
                    console.error('[Edit/Calendar]', e.message);
                }
            }
        }

        // Push notification
        const notifyEmail = ownerEmail || appt.owner;
        if (notifyEmail) {
            await sendFCMToUser(notifyEmail, buildEditNotification(appt, field, oldValue, resolvedValue));
        }

        return res.json({ success: true, oldValue, newValue: resolvedValue });
    } catch (err) {
        console.error('[AppointmentEdit]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// FCM ROUTES
// ════════════════════════════════════════════════════════════════════════════

async function handleFCMRegisterToken(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { userEmail, fcmToken } = req.body || {};
    if (!userEmail || !fcmToken)
        return res.status(400).json({ success: false, message: 'Missing userEmail or fcmToken.' });

    try {
        const db = getDb();
        const userRef = db.collection('users').doc(userEmail);
        const snap = await userRef.get();
        const existing = snap.exists ? (snap.data()?.fcmTokens || []) : [];

        if (!existing.includes(fcmToken)) {
            await userRef.set({
                fcmTokens: [...existing, fcmToken],
                notificationsEnabled: true,
                notificationsConnectedAt: new Date().toISOString()
            }, { merge: true });
        } else {
            await userRef.set({ notificationsEnabled: true }, { merge: true });
        }

        return res.json({ success: true, message: 'Device registered for notifications.' });
    } catch (err) {
        console.error('[FCM-Register]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

async function handleFCMRemoveToken(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { userEmail, fcmToken } = req.body || {};
    if (!userEmail) return res.status(400).json({ success: false, message: 'Missing userEmail.' });

    try {
        const db = getDb();
        const userRef = db.collection('users').doc(userEmail);
        const snap = await userRef.get();
        if (!snap.exists) return res.json({ success: true });

        const existing = snap.data()?.fcmTokens || [];
        const remaining = fcmToken ? existing.filter(t => t !== fcmToken) : [];
        await userRef.update({ fcmTokens: remaining, notificationsEnabled: remaining.length > 0 });

        return res.json({ success: true, message: 'Notifications disconnected.' });
    } catch (err) {
        console.error('[FCM-Remove]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

async function handleFCMTestNotification(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { userEmail } = req.body || {};
    if (!userEmail) return res.status(400).json({ success: false, message: 'Missing userEmail.' });

    try {
        const result = await sendFCMToUser(userEmail, {
            title: '✅ Notifications Connected!',
            body:  'This is a test alert from Comex AI. You will receive one like this for every new appointment.',
            url:   '/?view=integrations',
            tag:   'comex-test'
        });

        if (result.sent === 0) {
            return res.status(400).json({ success: false, message: 'No active devices found. Try reconnecting.' });
        }
        return res.json({ success: true, message: `Test notification sent to ${result.sent} device(s).` });
    } catch (err) {
        console.error('[FCM-Test]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
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
            designConfig: b.designConfig             || {},
            modelKey:     b.modelKey                 || DEFAULT_MODEL_KEY
        });
    } catch (err) {
        console.error('[Config]', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// CHAT — with CANCEL / EDIT / multi-model support
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
        let modelKey   = DEFAULT_MODEL_KEY;

        if (botSnap.exists) {
            const b  = botSnap.data();
            ownerEmail = b.owner || '';
            botName    = b.name  || 'Assistant';
            modelKey   = b.modelKey || DEFAULT_MODEL_KEY;
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

        // ── CANCEL / EDIT INTENT DETECTION ────────────────────────────────
        const msgLower = userMsg.toLowerCase().trim();

        // Detect CANCEL confirmation
        const isCancelConfirm = /^(yes,?\s*)?(please\s+)?(cancel|delete|remove)\s*(it|this|the appointment|my appointment)?\.?$/i.test(msgLower) ||
                                 /^(confirm cancel|yes cancel|cancel confirmed|go ahead and cancel)\.?$/i.test(msgLower);

        // Detect initial CANCEL intent
        const isCancelIntent = /\bcancel\b/.test(msgLower) && !isCancelConfirm;

        // Detect EDIT intent
        const isEditIntent = /\b(edit|change|update|modify|reschedule)\b/.test(msgLower);

        // Check if we're in a pending cancel flow (set via prior assistant message context)
        const safeHistory = (Array.isArray(history) ? history : []).slice(-12).filter(m => m?.role && m?.content);
        const lastAssistantMsg = [...safeHistory].reverse().find(m => m.role === 'assistant')?.content || '';
        const isPendingCancel = /confirm.*cancel|type.*yes.*cancel|cancel.*confirm/i.test(lastAssistantMsg);
        const isPendingEdit   = /which.*field|what.*change|name.*contact.*date.*time/i.test(lastAssistantMsg);
        const isPendingEditValue = /new.*value|what.*would.*you.*like.*change.*to|enter.*new/i.test(lastAssistantMsg);

        // Find the most recent appointment for this conversation
        async function findConversationAppointment() {
            const apptSnap = await db.collection('appointments')
                .where('conversationId', '==', convId)
                .where('status', '==', 'confirmed')
                .orderBy('createdAt', 'desc')
                .limit(1)
                .get();

            if (!apptSnap.empty) return { id: apptSnap.docs[0].id, ...apptSnap.docs[0].data() };

            // Also check bot sub-collection
            const botApptSnap = await db.collection('user_bots').doc(businessId)
                .collection('appointments')
                .where('status', '==', 'confirmed')
                .orderBy('createdAt', 'desc')
                .limit(1)
                .get();

            if (!botApptSnap.empty) return { id: botApptSnap.docs[0].id, ...botApptSnap.docs[0].data() };
            return null;
        }

        // ── HANDLE: User says "CANCEL" ──────────────────────────────────
        if (isCancelIntent && !isPendingCancel) {
            // Ask for confirmation
            const reply = `Are you sure you want to cancel your appointment? Type "YES, CANCEL" to confirm, or "no" to keep it.`;
            await logChat(db, businessId, convId, userMsg, reply, false, false);
            return res.json({ success: true, answer: reply, reply });
        }

        // ── HANDLE: User confirms cancellation ─────────────────────────
        if ((isCancelConfirm && isPendingCancel) || (msgLower === 'yes, cancel' || msgLower === 'yes cancel')) {
            const appt = await findConversationAppointment();
            if (!appt) {
                const reply = "I couldn't find an active appointment to cancel. Please contact us directly.";
                return res.json({ success: true, answer: reply, reply });
            }

            // Cancel via internal API call
            try {
                await db.collection('appointments').doc(appt.id).update({
                    status: 'cancelled',
                    cancelledAt: new Date().toISOString()
                });

                // Update bot sub-collection
                const botApptsRef = db.collection('user_bots').doc(businessId).collection('appointments');
                const q = await botApptsRef.where('conversationId', '==', convId).get();
                q.forEach(d => d.ref.update({ status: 'cancelled', cancelledAt: new Date().toISOString() }));

                // Delete Google Calendar event if present
                if (appt.googleCalendarEventId && ownerEmail) {
                    try {
                        const userSnap = await db.collection('users').doc(ownerEmail).get();
                        const googleAuth = userSnap.data()?.integrations?.google_calendar;
                        if (googleAuth?.connected) {
                            const token = await refreshTokenIfNeeded(googleAuth, ownerEmail, db);
                            await fetch(
                                `https://www.googleapis.com/calendar/v3/calendars/primary/events/${appt.googleCalendarEventId}`,
                                { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
                            );
                        }
                    } catch (e) { console.error('[Cancel/Calendar]', e.message); }
                }

                // Send push notification
                if (ownerEmail) {
                    await sendFCMToUser(ownerEmail, buildCancellationNotification(appt)).catch(e => console.error('[Cancel/FCM]', e.message));
                }

                const reply = `✅ Your appointment has been successfully cancelled.\n\n📅 Cancelled: ${appt.scheduledDate} at ${appt.appointmentTime}\n👤 Name: ${appt.customerName}\n\nIf you'd like to rebook, just say "I want to book an appointment".`;
                await logChat(db, businessId, convId, userMsg, reply, false, false);
                return res.json({ success: true, answer: reply, reply });

            } catch (e) {
                const reply = 'There was an error cancelling your appointment. Please try again.';
                return res.json({ success: true, answer: reply, reply });
            }
        }

        // ── HANDLE: User says "EDIT" ────────────────────────────────────
        if (isEditIntent && !isPendingEdit && !isPendingEditValue) {
            const reply = `Which detail would you like to change?\n\n1. **Name**\n2. **Contact info** (email/phone)\n3. **Date**\n4. **Time**\n\nPlease type the number or the field name.`;
            await logChat(db, businessId, convId, userMsg, reply, false, false);
            return res.json({ success: true, answer: reply, reply });
        }

        // ── HANDLE: User picked a field to edit ────────────────────────
        if (isPendingEdit && !isPendingEditValue) {
            const fieldMap = {
                '1': 'customerName',   'name': 'customerName',
                '2': 'contactInfo',    'contact': 'contactInfo', 'email': 'contactInfo', 'phone': 'contactInfo',
                '3': 'appointmentDay', 'date': 'appointmentDay',
                '4': 'appointmentTime','time': 'appointmentTime'
            };
            const key = msgLower.replace(/[^a-z0-9]/g,'');
            const field = fieldMap[key] || fieldMap[msgLower.split(/\s+/)[0]];

            if (!field) {
                const reply = 'I didn\'t catch that. Please type: "name", "contact", "date", or "time".';
                return res.json({ success: true, answer: reply, reply });
            }

            const fieldLabels = { customerName:'name', contactInfo:'contact info', appointmentDay:'date', appointmentTime:'time' };
            const reply = `What would you like to change the ${fieldLabels[field]} to?`;
            await logChat(db, businessId, convId, userMsg, reply, false, false);
            return res.json({ success: true, answer: reply, reply, _editField: field });
        }

        // ── HANDLE: User provides new value for edit ────────────────────
        if (isPendingEditValue) {
            // Extract which field we were editing from history
            const editFieldMsg = [...safeHistory].reverse().find(m =>
                m.role === 'assistant' && m.content.includes('_editField:')
            );
            // Fallback: parse from last assistant message context
            const fieldHint = lastAssistantMsg.match(/change the (name|contact info|date|time) to/i)?.[1];
            const fieldMap2 = { 'name': 'customerName', 'contact info': 'contactInfo', 'date': 'appointmentDay', 'time': 'appointmentTime' };
            const field = fieldHint ? fieldMap2[fieldHint.toLowerCase()] : null;

            if (!field) {
                // Can't determine field — fall through to normal LLM handling
            } else {
                const appt = await findConversationAppointment();
                if (appt) {
                    const oldValue = appt[field];
                    let newValue = userMsg.trim();
                    let scheduledDateUpdate = {};

                    if (field === 'appointmentDay') {
                        const iso = resolveDay(newValue);
                        scheduledDateUpdate = { scheduledDate: iso };
                    }

                    await db.collection('appointments').doc(appt.id).update({
                        [field]: newValue,
                        ...scheduledDateUpdate,
                        updatedAt: new Date().toISOString()
                    });

                    // Update bot sub-collection
                    const botApptsRef = db.collection('user_bots').doc(businessId).collection('appointments');
                    const q = await botApptsRef.where('conversationId', '==', convId).get();
                    q.forEach(d => d.ref.update({ [field]: newValue, ...scheduledDateUpdate, updatedAt: new Date().toISOString() }));

                    // Send push notification
                    if (ownerEmail) {
                        await sendFCMToUser(ownerEmail, buildEditNotification(appt, field, oldValue, newValue)).catch(e => console.error('[Edit/FCM]', e.message));
                    }

                    const fieldLabels2 = { customerName:'name', contactInfo:'contact info', appointmentDay:'date', appointmentTime:'time' };
                    const reply = `✅ Updated! Your ${fieldLabels2[field]} has been changed from "${oldValue}" to "${newValue}".\n\nIs there anything else you'd like to change, or are you all set?`;
                    await logChat(db, businessId, convId, userMsg, reply, false, false);
                    return res.json({ success: true, answer: reply, reply });
                }
            }
        }

        // ── NORMAL CHAT FLOW ───────────────────────────────────────────
        sysPrompt += `

PERSONALITY & BEHAVIOR:
- You are a warm, helpful customer service assistant. Answer questions naturally.
- Do NOT bring up appointment booking unless the user explicitly asks to book/schedule/set up an appointment.
- Greetings like "hello", "hi" get a natural, friendly response — no booking prompts.
- If the user types "CANCEL", ask them to confirm with "YES, CANCEL".
- If the user types "EDIT", ask which field they want to change: name, contact info, date, or time. Then ask for the new value.
- NEVER output raw JSON or function call arguments as plain text — that is a critical error.

APPOINTMENT BOOKING (only when user explicitly asks):
Collect information ONE piece at a time in EXACTLY this order:
  1. Full name    → ask: "What's your name?"
  2. Contact info → ask: "What's your email or phone number?"
  3. Date         → ask: "What date would you prefer?"
  4. Time         → ask: "What time works best for you on [date]?"

CRITICAL TIME RULES:
- You MUST ask for the time explicitly. Never assume or skip it.
- If the user provides a date without a time, ask: "What time works best for you on [date]?"
- Do NOT trigger the booking function until you have an explicit time confirmed.

OTHER RULES:
- Extract name from any phrasing: "I am Atharva", "It's Atharva", "My name is Atharva" → name is Atharva.
- Accept any date: "Monday", "19 June", "next Tuesday", "tomorrow", "17th June".
- Never re-ask for information already given in conversation history.
- Once you have all 4 fields confirmed, immediately call the appointmentBooking tool.`;

        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const modelId = resolveModelId(modelKey);

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
            model:    modelId,
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
                            appointmentTime: { type: 'string', description: 'Exact time as stated by the user' }
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

            // Availability check
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

            const appt = {
                businessId, botName, owner: ownerEmail, conversationId: convId,
                customerName: userName, contactInfo,
                appointmentDay, appointmentTime, scheduledDate: dateISO,
                status: 'confirmed', createdAt: new Date().toISOString(),
                googleCalendarEventId: null
            };

            const apptDocRef = await db.collection('appointments').add(appt);
            await db.collection('user_bots').doc(businessId).collection('appointments').add({ ...appt, globalId: apptDocRef.id });

            // Google Calendar event
            if (ownerEmail) {
                const userSnap     = await db.collection('users').doc(ownerEmail).get();
                const integrations = userSnap.exists ? (userSnap.data()?.integrations || {}) : {};
                if (integrations.google_calendar?.connected) {
                    try {
                        const calResult = await addCalendarEvent(integrations.google_calendar, appt, ownerEmail, db);
                        if (calResult?.eventId) {
                            await apptDocRef.update({ googleCalendarEventId: calResult.eventId });
                        }
                    }
                    catch (e) { console.error('[Chat/Calendar]', e.message); }
                }
            }

            // Push notification
            if (ownerEmail) {
                try { await sendFCMToUser(ownerEmail, buildBookingNotification(appt)); }
                catch (e) { console.error('[FCM] Booking notify error:', e.message); }
            }

            await logChat(db, businessId, convId, userMsg, 'Appointment booked.', true, true);

            const answer = [
                '✅ APPOINTMENT BOOKED',
                '',
                `📅 Date:     ${dateISO}`,
                `🕐 Time:     ${appointmentTime}`,
                `👤 Name:     ${userName}`,
                `📧 Contact:  ${contactInfo}`,
                '',
                'Reply with "CANCEL" to cancel or "EDIT" to change a detail.'
            ].join('\n');

            return res.json({ success: true, answer, reply: answer });
        }

        // Plain reply
        const answer = choice?.content?.trim() || 'How can I help you?';
        await logChat(db, businessId, convId, userMsg, answer, true, false);
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
// GOOGLE OAUTH
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

        // Fetch user's Google profile to get calendar label
        let calendarLabel = email;
        try {
            const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${tokens.access_token}` }
            });
            const profile = await profileRes.json();
            calendarLabel = profile.email || email;
        } catch (e) { /* best-effort */ }

        const db = getDb();
        const userSnap = await db.collection('users').doc(email).get();
        const existing = userSnap.exists ? (userSnap.data()?.integrations?.google_calendar_accounts || []) : [];

        // Store this account in an array so multiple accounts are supported
        const newAccount = {
            email:         calendarLabel,
            connected:     true,
            access_token:  tokens.access_token,
            refresh_token: tokens.refresh_token || null,
            expiry_date:   tokens.expires_in
                ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
                : new Date(Date.now() + 3600 * 1000).toISOString(),
            connectedAt:   new Date().toISOString()
        };

        // Upsert by email
        const idx = existing.findIndex(a => a.email === calendarLabel);
        if (idx >= 0) existing[idx] = newAccount;
        else existing.push(newAccount);

        await db.collection('users').doc(email).set({
            integrations: {
                // Keep legacy single-account field for backwards-compat with chat handler
                google_calendar: {
                    connected:     true,
                    access_token:  tokens.access_token,
                    refresh_token: tokens.refresh_token || null,
                    expiry_date:   newAccount.expiry_date
                },
                google_calendar_accounts: existing
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

async function logChat(db, businessId, convId, question, answer, isGenuineQuery, isLeadCaptured) {
    try {
        await db.collection('user_bots').doc(businessId).collection('chats').add({
            conversationId: convId, question, answer, isGenuineQuery, isLeadCaptured,
            createdAt: new Date().toISOString()
        });
    } catch (e) { console.warn('[Chat] Log error:', e.message); }
}

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
            }
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
    if (!parsed) { console.error(`[Calendar] Cannot parse time "${appt.appointmentTime}"`); return null; }

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
    if (!r.ok) { console.error('[Calendar] Event error:', data.error?.message); return null; }
    return { eventId: data.id, eventLink: data.htmlLink };
}

async function updateCalendarEvent(googleAuth, eventId, appt, ownerEmail, db) {
    const accessToken = await refreshTokenIfNeeded(googleAuth, ownerEmail, db);
    const parsed = parseTime(appt.appointmentTime);
    if (!parsed) return;

    const { h, min } = parsed;
    const timeZone   = await getCalendarTimezone(accessToken);
    const localStart = `${appt.scheduledDate}T${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:00`;
    const endH = h + Math.floor((min+30)/60), endMin = (min+30)%60;
    const localEnd = `${appt.scheduledDate}T${String(endH).padStart(2,'0')}:${String(endMin).padStart(2,'0')}:00`;

    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            summary:     `Appointment: ${appt.customerName}`,
            description: `Contact: ${appt.contactInfo}\nBooked via Comex AI`,
            start: { dateTime: localStart, timeZone },
            end:   { dateTime: localEnd,   timeZone }
        })
    });
    if (!r.ok) {
        const d = await r.json();
        console.error('[Calendar] Update error:', d.error?.message);
    }
}
