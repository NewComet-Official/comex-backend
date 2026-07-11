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

function getAuthAdmin() {
    if (!admin.apps.length) getDb();
    return admin.auth();
}

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ════════════════════════════════════════════════════════════════════════════
// MULTI-MODEL LLM ROUTER
// ════════════════════════════════════════════════════════════════════════════

const MODEL_REGISTRY = {
    'llama-3.3-70b':     { id: 'llama-3.3-70b-versatile', provider: 'groq',    label: 'Meta LLaMA 3.3 70B'      },
    'llama-3.1-8b':      { id: 'llama-3.1-8b-instant',    provider: 'groq',    label: 'Meta LLaMA 3.1 8B (Fast)' },
    'gpt-oss-120b':      { id: 'openai/gpt-oss-120b',     provider: 'groq',    label: 'OpenAI GPT-OSS 120B'     },
    'gpt-oss-20b':       { id: 'openai/gpt-oss-20b',      provider: 'groq',    label: 'OpenAI GPT-OSS 20B (Fast)' },
    'mistral-large':     { id: 'mistral-large-latest',    provider: 'mistral', label: 'Mistral Large'           },
    'mistral-small':     { id: 'mistral-small-latest',    provider: 'mistral', label: 'Mistral Small (Fast)'    },
    'gemini-2.5-flash':  { id: 'gemini-2.5-flash',        provider: 'google',  label: 'Gemini 2.5 Flash'        },
};

const DEFAULT_MODEL_KEY = 'llama-3.3-70b';

const BOOKING_SYSTEM_SUFFIX = `

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

const BOOKING_TOOL_DEF = {
    type: 'function',
    function: {
        name: 'appointmentBooking',
        description: 'Book an appointment. Call ONLY when you have confirmed: full name, contact info, date, AND an explicit time from the user.',
        parameters: {
            type: 'object',
            properties: {
                userName:        { type: 'string', description: 'Full name of the customer'       },
                contactInfo:     { type: 'string', description: 'Email or phone number'           },
                appointmentDay:  { type: 'string', description: 'Date or day of the appointment' },
                appointmentTime: { type: 'string', description: 'Exact time as stated by the user'},
            },
            required: ['userName', 'contactInfo', 'appointmentDay', 'appointmentTime'],
        },
    },
};

async function callLLM({ modelKey, messages, toolChoice, allFieldsPresent, enableBookingTool }) {
    const entry = MODEL_REGISTRY[modelKey] || MODEL_REGISTRY[DEFAULT_MODEL_KEY];
    const tools = enableBookingTool ? [BOOKING_TOOL_DEF] : undefined;
    const toolChoiceValue = enableBookingTool
        ? (allFieldsPresent ? { type: 'function', function: { name: 'appointmentBooking' } } : 'auto')
        : undefined;

    if (entry.provider === 'groq') {
        if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set.');
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const completion = await groq.chat.completions.create({
            model:       entry.id,
            messages,
            ...(tools ? { tools, tool_choice: toolChoiceValue } : {}),
            temperature: 0.3,
            max_tokens:  600,
        });
        return completion.choices[0]?.message || {};
    }

    if (entry.provider === 'mistral') {
        const apiKey = process.env.MISTRAL_API_KEY;
        if (!apiKey) throw new Error('MISTRAL_API_KEY not set.');

        const body = {
            model:       entry.id,
            messages,
            ...(tools ? { tools, tool_choice: toolChoiceValue } : {}),
            temperature: 0.3,
            max_tokens:  600,
        };

        const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
            method:  'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
        });

        if (!r.ok) {
            const err = await r.text();
            throw new Error(`Mistral AI error ${r.status}: ${err}`);
        }

        const data = await r.json();
        const msg  = data.choices?.[0]?.message || {};

        if (Array.isArray(msg.tool_calls)) {
            msg.tool_calls = msg.tool_calls.map(tc => {
                if (tc?.function && typeof tc.function.arguments !== 'string') {
                    return { ...tc, function: { ...tc.function, arguments: JSON.stringify(tc.function.arguments) } };
                }
                return tc;
            });
        }

        return msg;
    }

    if (entry.provider === 'google') {
        const apiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
        if (!apiKey) throw new Error('GOOGLE_AI_STUDIO_API_KEY not set.');

        const url = `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`;

        const body = {
            model:       entry.id,
            messages,
            ...(tools ? { tools, tool_choice: toolChoiceValue } : {}),
            temperature: 0.3,
            max_tokens:  600,
        };

        const r = await fetch(url, {
            method:  'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
        });

        if (!r.ok) {
            const err = await r.text();
            throw new Error(`Google AI Studio error ${r.status}: ${err}`);
        }

        const data = await r.json();
        return data.choices?.[0]?.message || {};
    }

    throw new Error(`Unknown provider: ${entry.provider}`);
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
    if (path === '/api/disconnect-calendar')      return handleDisconnectCalendar(req, res);
    if (path === '/api/report/submit')            return handleReportSubmit(req, res);
    if (path === '/api/bot/delete-cascade')       return handleBotDeleteCascade(req, res);
    if (path === '/api/account/delete-cascade')   return handleAccountDeleteCascade(req, res);

    // ── Database source integrations (Firebase Project / Supabase) ────────
    if (path === '/api/oauth/firebase-project')          return handleFirebaseProjectOAuth(req, res);
    if (path === '/api/oauth/firebase-project/callback')  return handleFirebaseProjectCallback(req, res);
    if (path === '/api/oauth/supabase')                   return handleSupabaseOAuth(req, res);
    if (path === '/api/oauth/supabase/callback')          return handleSupabaseCallback(req, res);
    if (path === '/api/integrations/list-projects')       return handleListProjects(req, res);
    if (path === '/api/integrations/disconnect-database')  return handleDisconnectDatabase(req, res);

    return res.status(404).json({ success: false, message: `Unknown route: ${path}` });
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/models
// ════════════════════════════════════════════════════════════════════════════
async function handleModels(req, res) {
    const models = Object.entries(MODEL_REGISTRY).map(([key, val]) => ({
        key,
        label:    val.label,
        provider: val.provider,
    }));
    return res.json({ success: true, models });
}

// ════════════════════════════════════════════════════════════════════════════
// CASCADE-DELETE HELPERS
// ════════════════════════════════════════════════════════════════════════════

async function deleteQueryBatch(db, queryRef, batchSize = 400) {
    let deleted = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const snap = await queryRef.limit(batchSize).get();
        if (snap.empty) break;
        const batch = db.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        deleted += snap.size;
        if (snap.size < batchSize) break;
    }
    return deleted;
}

async function deleteSubcollection(db, parentRef, subName) {
    return deleteQueryBatch(db, parentRef.collection(subName));
}

async function wipeBotCompletely(db, botId) {
    const botRef = db.collection('user_bots').doc(botId);

    await deleteSubcollection(db, botRef, 'chats');
    await deleteSubcollection(db, botRef, 'appointments');
    await deleteSubcollection(db, botRef, 'reports');

    await deleteQueryBatch(db, db.collection('appointments').where('businessId', '==', botId));
    await deleteQueryBatch(db, db.collection('reports').where('businessId', '==', botId));
    await deleteQueryBatch(db, db.collection('leads').where('businessId', '==', botId));

    await botRef.delete().catch(() => {});
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/bot/delete-cascade  — permanently wipes a bot and ALL of its data
// ════════════════════════════════════════════════════════════════════════════
async function handleBotDeleteCascade(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { businessId, ownerEmail } = req.body || {};
    if (!businessId || !ownerEmail)
        return res.status(400).json({ success: false, message: 'Missing businessId or ownerEmail.' });

    try {
        const db = getDb();
        const botSnap = await db.collection('user_bots').doc(businessId).get();

        if (botSnap.exists && botSnap.data()?.owner !== ownerEmail) {
            return res.status(403).json({ success: false, message: 'You do not own this agent.' });
        }

        await wipeBotCompletely(db, businessId);

        return res.json({ success: true, message: 'Agent and all associated data permanently deleted.' });
    } catch (err) {
        console.error('[BotDeleteCascade]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/account/delete-cascade — permanently wipes a user + everything they own
// ════════════════════════════════════════════════════════════════════════════
async function handleAccountDeleteCascade(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ success: false, message: 'Missing email.' });

    try {
        const db = getDb();

        const botsSnap = await db.collection('user_bots').where('owner', '==', email).get();
        for (const d of botsSnap.docs) {
            await wipeBotCompletely(db, d.id);
        }

        await deleteQueryBatch(db, db.collection('appointments').where('owner', '==', email));
        await deleteQueryBatch(db, db.collection('reports').where('owner', '==', email));
        await deleteQueryBatch(db, db.collection('leads').where('owner', '==', email));

        await db.collection('users').doc(email).delete().catch(() => {});

        try {
            const authAdmin = getAuthAdmin();
            const userRecord = await authAdmin.getUserByEmail(email);
            await authAdmin.deleteUser(userRecord.uid);
        } catch (e) {
            console.warn('[AccountDeleteCascade] Auth admin delete skipped:', e.message);
        }

        return res.json({ success: true, message: 'Account and all associated data permanently deleted.' });
    } catch (err) {
        console.error('[AccountDeleteCascade]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
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
            tag:   tag   || 'comex-general',
        },
        webpush: { fcmOptions: { link: url || '/' } },
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
            ) deadTokens.push(tokens[i]);
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
        tag:   'comex-appointment',
    };
}

function buildCancellationNotification(appt) {
    return {
        title: '❌ Appointment Cancelled',
        body:  `APPOINTMENT CANCELLED\nAppointment booked on ${appt.scheduledDate} at ${appt.appointmentTime} by ${appt.customerName} has been cancelled by the client itself`,
        url:   '/?view=analytics',
        tag:   'comex-appointment-cancel',
    };
}

function buildEditNotification(appt, field, oldData, newData) {
    const fieldLabels = {
        customerName:    'name',
        contactInfo:     'contact info',
        appointmentDay:  'date',
        appointmentTime: 'time',
        scheduledDate:   'date',
    };
    const label = fieldLabels[field] || field;
    return {
        title: '✏️ Appointment Edited',
        body:  `APPOINTMENT EDITED\n${appt.customerName} edited the ${label} from "${oldData}" to "${newData}"`,
        url:   '/?view=analytics',
        tag:   'comex-appointment-edit',
    };
}

function buildReportNotification(botName, writtenReport) {
    return {
        title: '🚩 New Bot Report',
        body:  `A user reported an answer from "${botName}": ${String(writtenReport || '').substring(0, 120)}`,
        url:   '/?view=reports',
        tag:   'comex-report',
    };
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/appointment/cancel
// ════════════════════════════════════════════════════════════════════════════
async function handleAppointmentCancel(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { appointmentId, businessId, ownerEmail } = req.body || {};
    if (!appointmentId || !businessId)
        return res.status(400).json({ success: false, message: 'Missing appointmentId or businessId.' });

    try {
        const db = getDb();
        const apptRef  = db.collection('appointments').doc(appointmentId);
        const apptSnap = await apptRef.get();

        if (!apptSnap.exists)
            return res.status(404).json({ success: false, message: 'Appointment not found.' });

        const appt = apptSnap.data();
        await apptRef.update({ status: 'cancelled', cancelledAt: new Date().toISOString() });

        const botApptsRef = db.collection('user_bots').doc(businessId).collection('appointments');
        const q = await botApptsRef.where('conversationId', '==', appt.conversationId).get();
        q.forEach(d => d.ref.update({ status: 'cancelled', cancelledAt: new Date().toISOString() }));

        if (appt.googleCalendarEventId && ownerEmail) {
            try {
                const userSnap   = await db.collection('users').doc(ownerEmail).get();
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

        const notifyEmail = ownerEmail || appt.owner;
        if (notifyEmail) await sendFCMToUser(notifyEmail, buildCancellationNotification(appt));

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

    const EDITABLE_FIELDS = ['customerName', 'contactInfo', 'appointmentDay', 'appointmentTime', 'scheduledDate'];
    if (!EDITABLE_FIELDS.includes(field))
        return res.status(400).json({ success: false, message: `Field "${field}" is not editable.` });

    try {
        const db      = getDb();
        const apptRef  = db.collection('appointments').doc(appointmentId);
        const apptSnap = await apptRef.get();

        if (!apptSnap.exists)
            return res.status(404).json({ success: false, message: 'Appointment not found.' });

        const appt     = apptSnap.data();
        const oldValue = appt[field] || '(not set)';
        let resolvedValue = newValue;

        if (field === 'appointmentDay') {
            const iso = resolveDay(newValue);
            await apptRef.update({ [field]: newValue, scheduledDate: iso, updatedAt: new Date().toISOString() });
        } else {
            await apptRef.update({ [field]: resolvedValue, updatedAt: new Date().toISOString() });
        }

        if (businessId) {
            const botApptsRef = db.collection('user_bots').doc(businessId).collection('appointments');
            const q = await botApptsRef.where('conversationId', '==', appt.conversationId).get();
            q.forEach(d => d.ref.update({ [field]: resolvedValue, updatedAt: new Date().toISOString() }));
        }

        if ((field === 'appointmentDay' || field === 'appointmentTime') && appt.googleCalendarEventId) {
            const notifyEmail = ownerEmail || appt.owner;
            if (notifyEmail) {
                try {
                    const userSnap   = await db.collection('users').doc(notifyEmail).get();
                    const googleAuth = userSnap.data()?.integrations?.google_calendar;
                    if (googleAuth?.connected) {
                        const updatedAppt = { ...appt, [field]: resolvedValue };
                        if (field === 'appointmentDay') updatedAppt.scheduledDate = resolveDay(resolvedValue);
                        await updateCalendarEvent(googleAuth, appt.googleCalendarEventId, updatedAppt, notifyEmail, db);
                    }
                } catch (e) { console.error('[Edit/Calendar]', e.message); }
            }
        }

        const notifyEmail = ownerEmail || appt.owner;
        if (notifyEmail) await sendFCMToUser(notifyEmail, buildEditNotification(appt, field, oldValue, resolvedValue));

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
        const db      = getDb();
        const userRef  = db.collection('users').doc(userEmail);
        const snap     = await userRef.get();
        const existing = snap.exists ? (snap.data()?.fcmTokens || []) : [];

        if (!existing.includes(fcmToken)) {
            await userRef.set({
                fcmTokens: [...existing, fcmToken],
                notificationsEnabled: true,
                notificationsConnectedAt: new Date().toISOString(),
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
        const db      = getDb();
        const userRef  = db.collection('users').doc(userEmail);
        const snap     = await userRef.get();
        if (!snap.exists) return res.json({ success: true });

        const existing  = snap.data()?.fcmTokens || [];
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
            tag:   'comex-test',
        });

        if (result.sent === 0)
            return res.status(400).json({ success: false, message: 'No active devices found. Try reconnecting.' });

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
            signal:  AbortSignal.timeout(12000),
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
            success:         true,
            name:            b.name                     || 'AI Assistant',
            position:        b.position                 || 'bottom-right',
            logoBase64:      b.logoBase64               || null,
            themeColor:      b.designConfig?.themeColor || '#0f172a',
            designConfig:    b.designConfig             || {},
            modelKey:        b.modelKey                 || DEFAULT_MODEL_KEY,
            behaviorConfig:  Object.assign({
                allowOutOfTopic:      true,
                allowWebSearch:       true,
                allowHallucination:   false,
                allowAppointmentBooking: false,
            }, b.behaviorConfig || {}),
            messageConfig:   Object.assign({
                user: { showTime: true, editMessage: true, copy: true },
                bot:  { showTime: true, copy: true, regenerate: true, report: true },
            }, b.messageConfig || {}),
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

    const convId = inId || `conv-${Date.now()}`;
    const db     = getDb();

    try {
        const botSnap = await db.collection('user_bots').doc(businessId).get();
        let sysPrompt  = 'You are a helpful, friendly customer service assistant.';
        let ownerEmail = '', botName = 'Assistant';
        let modelKey   = DEFAULT_MODEL_KEY;
        let behaviorConfig = {
            allowOutOfTopic: true,
            allowWebSearch: true,
            allowHallucination: false,
            allowAppointmentBooking: false,
        };

        if (botSnap.exists) {
            const b  = botSnap.data();
            ownerEmail = b.owner    || '';
            botName    = b.name     || 'Assistant';
            modelKey   = b.modelKey || DEFAULT_MODEL_KEY;
            behaviorConfig = Object.assign(behaviorConfig, b.behaviorConfig || {});
            const kc   = b.knowledgeContext || {};
            if (kc.systemPrompt) {
                sysPrompt = kc.systemPrompt;
            } else if (b.context) {
                sysPrompt = `You are a helpful, friendly customer service assistant for "${botName}". Use the following business information to answer questions accurately:\n\n${b.context}`;
            }
            if (kc.fileContents) {
                sysPrompt += `\n\n[REFERENCE DOCUMENTS]:\n${String(kc.fileContents).substring(0, 6000)}`;
            }

            // ── Database sources (Firebase Project / Supabase) ──────────────
            // NOTE — PHASE 1 STUB: we only tell the model *that* a database is
            // connected, we do not read its live contents yet. Doing that for
            // real (potentially huge Postgres/Firestore projects) requires the
            // RAG pipeline (chunk → embed → vector search) described in
            // knowledgeContext.databaseSources — this is intentionally left as
            // a follow-up so we don't silently pretend to read data we aren't.
            const dbSources = kc.databaseSources || [];
            if (dbSources.length) {
                const list = dbSources.map(s => `- ${s.service} project "${s.projectName || s.projectId}"`).join('\n');
                sysPrompt += `\n\n[CONNECTED DATABASES]:\nThe following databases are linked to this agent, but live querying is not yet wired up:\n${list}\nIf asked about live data in these databases, say that live database lookups are coming soon rather than guessing.`;
            }
        }

        // ── Behavior toggles: out-of-topic / web search / hallucination ────
        sysPrompt += `\n\nBEHAVIOR SETTINGS:`;
        sysPrompt += behaviorConfig.allowOutOfTopic
            ? `\n- You MAY answer casual, general-knowledge, or out-of-topic questions (e.g. "What is Google?") in a friendly way, even if unrelated to the business.`
            : `\n- You must ONLY answer questions related to this business/agent's knowledge base. If the user asks an unrelated, casual, or general-knowledge question, politely explain you can only help with questions about this business and steer them back.`;
        sysPrompt += behaviorConfig.allowWebSearch
            ? `\n- You may reason as if you have broad general knowledge of the world to help answer questions beyond the provided context.`
            : `\n- Do NOT claim to search the web or provide information beyond the given business context and your own reliable general knowledge; if you don't have the information in your context, say so.`;
        sysPrompt += behaviorConfig.allowHallucination
            ? `\n- If you do not know the exact answer, you may provide your best reasonable guess, but keep it plausible.`
            : `\n- If you do not know the answer or it is not in the provided context, honestly say you don't have that information instead of guessing or making something up.`;

        const bookingEnabled = !!behaviorConfig.allowAppointmentBooking;
        if (bookingEnabled) {
            sysPrompt += BOOKING_SYSTEM_SUFFIX;
        } else {
            sysPrompt += `\n\n- Appointment booking is DISABLED for this agent. If a user asks to book an appointment, politely let them know booking isn't available here and offer to help another way.`;
        }

        const msgLower = userMsg.toLowerCase().trim();

        const isCancelConfirm = bookingEnabled && (/^(yes,?\s*)?(please\s+)?(cancel|delete|remove)\s*(it|this|the appointment|my appointment)?\.?$/i.test(msgLower) ||
                                 /^(confirm cancel|yes cancel|cancel confirmed|go ahead and cancel)\.?$/i.test(msgLower));
        const isCancelIntent  = bookingEnabled && /\bcancel\b/.test(msgLower) && !isCancelConfirm;
        const isEditIntent    = bookingEnabled && /\b(edit|change|update|modify|reschedule)\b/.test(msgLower);

        const safeHistory = (Array.isArray(history) ? history : []).slice(-12).filter(m => m?.role && m?.content);
        const lastAssistantMsg = [...safeHistory].reverse().find(m => m.role === 'assistant')?.content || '';
        const isPendingCancel     = bookingEnabled && /confirm.*cancel|type.*yes.*cancel|cancel.*confirm/i.test(lastAssistantMsg);
        const isPendingEdit       = bookingEnabled && /which.*field|what.*change|name.*contact.*date.*time/i.test(lastAssistantMsg);
        const isPendingEditValue  = bookingEnabled && /new.*value|what.*would.*you.*like.*change.*to|enter.*new/i.test(lastAssistantMsg);

        async function findConversationAppointment() {
            const apptSnap = await db.collection('appointments')
                .where('conversationId', '==', convId)
                .where('status', '==', 'confirmed')
                .orderBy('createdAt', 'desc')
                .limit(1)
                .get();
            if (!apptSnap.empty) return { id: apptSnap.docs[0].id, ...apptSnap.docs[0].data() };

            const botApptSnap = await db.collection('user_bots').doc(businessId)
                .collection('appointments')
                .where('status', '==', 'confirmed')
                .orderBy('createdAt', 'desc')
                .limit(1)
                .get();
            if (!botApptSnap.empty) return { id: botApptSnap.docs[0].id, ...botApptSnap.docs[0].data() };
            return null;
        }

        if (isCancelIntent && !isPendingCancel) {
            const reply = `Are you sure you want to cancel your appointment? Type "YES, CANCEL" to confirm, or "no" to keep it.`;
            await logChat(db, businessId, convId, userMsg, reply, false, false);
            return res.json({ success: true, answer: reply, reply });
        }

        if (bookingEnabled && ((isCancelConfirm && isPendingCancel) || (msgLower === 'yes, cancel' || msgLower === 'yes cancel'))) {
            const appt = await findConversationAppointment();
            if (!appt) {
                const reply = "I couldn't find an active appointment to cancel. Please contact us directly.";
                return res.json({ success: true, answer: reply, reply });
            }
            try {
                await db.collection('appointments').doc(appt.id).update({
                    status: 'cancelled', cancelledAt: new Date().toISOString(),
                });
                const botApptsRef = db.collection('user_bots').doc(businessId).collection('appointments');
                const q = await botApptsRef.where('conversationId', '==', convId).get();
                q.forEach(d => d.ref.update({ status: 'cancelled', cancelledAt: new Date().toISOString() }));

                if (appt.googleCalendarEventId && ownerEmail) {
                    try {
                        const userSnap   = await db.collection('users').doc(ownerEmail).get();
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

                if (ownerEmail)
                    await sendFCMToUser(ownerEmail, buildCancellationNotification(appt)).catch(e => console.error('[Cancel/FCM]', e.message));

                const reply = `✅ Your appointment has been successfully cancelled.\n\n📅 Cancelled: ${appt.scheduledDate} at ${appt.appointmentTime}\n👤 Name: ${appt.customerName}\n\nIf you'd like to rebook, just say "I want to book an appointment".`;
                await logChat(db, businessId, convId, userMsg, reply, false, false);
                return res.json({ success: true, answer: reply, reply });
            } catch {
                const reply = 'There was an error cancelling your appointment. Please try again.';
                return res.json({ success: true, answer: reply, reply });
            }
        }

        if (isEditIntent && !isPendingEdit && !isPendingEditValue) {
            const reply = `Which detail would you like to change?\n\n1. **Name**\n2. **Contact info** (email/phone)\n3. **Date**\n4. **Time**\n\nPlease type the number or the field name.`;
            await logChat(db, businessId, convId, userMsg, reply, false, false);
            return res.json({ success: true, answer: reply, reply });
        }

        if (isPendingEdit && !isPendingEditValue) {
            const fieldMap = {
                '1': 'customerName',    'name':    'customerName',
                '2': 'contactInfo',     'contact': 'contactInfo', 'email': 'contactInfo', 'phone': 'contactInfo',
                '3': 'appointmentDay',  'date':    'appointmentDay',
                '4': 'appointmentTime', 'time':    'appointmentTime',
            };
            const key   = msgLower.replace(/[^a-z0-9]/g, '');
            const field = fieldMap[key] || fieldMap[msgLower.split(/\s+/)[0]];
            if (!field) {
                const reply = 'I didn\'t catch that. Please type: "name", "contact", "date", or "time".';
                return res.json({ success: true, answer: reply, reply });
            }
            const fieldLabels = { customerName: 'name', contactInfo: 'contact info', appointmentDay: 'date', appointmentTime: 'time' };
            const reply = `What would you like to change the ${fieldLabels[field]} to?`;
            await logChat(db, businessId, convId, userMsg, reply, false, false);
            return res.json({ success: true, answer: reply, reply, _editField: field });
        }

        if (isPendingEditValue) {
            const fieldHint = lastAssistantMsg.match(/change the (name|contact info|date|time) to/i)?.[1];
            const fieldMap2 = { 'name': 'customerName', 'contact info': 'contactInfo', 'date': 'appointmentDay', 'time': 'appointmentTime' };
            const field     = fieldHint ? fieldMap2[fieldHint.toLowerCase()] : null;

            if (field) {
                const appt = await findConversationAppointment();
                if (appt) {
                    const oldValue = appt[field];
                    const newValue = userMsg.trim();
                    let scheduledDateUpdate = {};
                    if (field === 'appointmentDay') scheduledDateUpdate = { scheduledDate: resolveDay(newValue) };

                    await db.collection('appointments').doc(appt.id).update({
                        [field]: newValue, ...scheduledDateUpdate, updatedAt: new Date().toISOString(),
                    });
                    const botApptsRef = db.collection('user_bots').doc(businessId).collection('appointments');
                    const q = await botApptsRef.where('conversationId', '==', convId).get();
                    q.forEach(d => d.ref.update({ [field]: newValue, ...scheduledDateUpdate, updatedAt: new Date().toISOString() }));

                    if (ownerEmail)
                        await sendFCMToUser(ownerEmail, buildEditNotification(appt, field, oldValue, newValue)).catch(e => console.error('[Edit/FCM]', e.message));

                    const fieldLabels2 = { customerName: 'name', contactInfo: 'contact info', appointmentDay: 'date', appointmentTime: 'time' };
                    const reply = `✅ Updated! Your ${fieldLabels2[field]} has been changed from "${oldValue}" to "${newValue}".\n\nIs there anything else you'd like to change, or are you all set?`;
                    await logChat(db, businessId, convId, userMsg, reply, false, false);
                    return res.json({ success: true, answer: reply, reply });
                }
            }
        }

        const allText    = [...safeHistory.map(m => m.content), userMsg].join('\n');
        const allTextLow = allText.toLowerCase();

        const hasName    = /my name is|i am|i'm|it'?s\s+[a-z]+|name[:\s]+/i.test(allText) ||
                           safeHistory.some(m => m.role === 'user' && /^[A-Z][a-z]+ [A-Z][a-z]+/.test(m.content.trim()));
        const hasContact = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/.test(allText) ||
                           /(\+?\d[\d\s\-]{6,}\d)/.test(allText);
        const hasDay     = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}[\s\/\-](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}))\b/i.test(allTextLow);
        const hasTime    = /\b(\d{1,2}(:\d{2})?\s*(am|pm))\b/i.test(allText) ||
                           /\b(morning|afternoon|evening|noon|midday|midnight)\b/i.test(allTextLow) ||
                           /\b([01]?\d|2[0-3]):[0-5]\d\b/.test(allText);

        const isBookingConversation = bookingEnabled && /\b(book|schedule|appointment|slot|reserve|set up|fix a)\b/i.test(allTextLow);
        const allFieldsPresent      = isBookingConversation && hasName && hasContact && hasDay && hasTime;

        const choice = await callLLM({
            modelKey,
            messages: [
                { role: 'system', content: sysPrompt },
                ...safeHistory,
                { role: 'user', content: userMsg },
            ],
            allFieldsPresent,
            enableBookingTool: bookingEnabled,
        });

        if (bookingEnabled && choice?.content && !choice?.tool_calls) {
            const jsonMatch = choice.content.match(/\{[\s\S]*?"userName"[\s\S]*?"contactInfo"[\s\S]*?\}/);
            if (jsonMatch) {
                try {
                    const leaked = JSON.parse(jsonMatch[0]);
                    if (leaked.userName && leaked.contactInfo && leaked.appointmentDay && leaked.appointmentTime) {
                        choice.tool_calls = [{ function: { name: 'appointmentBooking', arguments: JSON.stringify(leaked) } }];
                        choice.content    = null;
                    }
                } catch { /* not valid JSON */ }
            }
        }

        if (bookingEnabled && choice?.tool_calls?.[0]?.function?.name === 'appointmentBooking') {
            let args;
            try { args = JSON.parse(choice.tool_calls[0].function.arguments); }
            catch { return res.json({ success: true, answer: 'Could you confirm your booking details again?' }); }

            const { userName, contactInfo, appointmentDay, appointmentTime } = args;

            if (!appointmentTime || appointmentTime.trim() === '' || /^tbd$/i.test(appointmentTime.trim())) {
                return res.json({
                    success: true,
                    answer:  `Got it! Just one more thing — what time works best for you on ${appointmentDay}?`,
                });
            }
            if (!userName || !contactInfo || !appointmentDay) {
                return res.json({
                    success: true,
                    answer:  'I need your name, contact info, preferred date and time to complete the booking. What would you like to provide?',
                });
            }

            const dateISO = resolveDay(appointmentDay);

            if (ownerEmail) {
                const userSnap     = await db.collection('users').doc(ownerEmail).get();
                const integrations = userSnap.exists ? (userSnap.data()?.integrations || {}) : {};
                if (integrations.google_calendar?.connected) {
                    const avail = await checkCalendarAvailability(integrations.google_calendar, dateISO, appointmentTime, ownerEmail, db);
                    if (!avail.available) {
                        const alts    = avail.suggestedTimes || [];
                        const altText = alts.length > 0
                            ? '\n\nHere are 3 available slots on that day:\n' + alts.map((t, i) => `  ${i + 1}. ${t}`).join('\n') + '\n\nWhich one works for you?'
                            : '\n\nWould you like to pick a different date or time?';
                        return res.json({ success: true, answer: `Sorry, ${appointmentTime} on ${appointmentDay} is already booked.${altText}` });
                    }
                }
            }

            const appt = {
                businessId, botName, owner: ownerEmail, conversationId: convId,
                customerName: userName, contactInfo,
                appointmentDay, appointmentTime, scheduledDate: dateISO,
                status: 'confirmed', createdAt: new Date().toISOString(),
                googleCalendarEventId: null,
            };

            const apptDocRef = await db.collection('appointments').add(appt);
            await db.collection('user_bots').doc(businessId).collection('appointments').add({ ...appt, globalId: apptDocRef.id });

            if (ownerEmail) {
                const userSnap     = await db.collection('users').doc(ownerEmail).get();
                const integrations = userSnap.exists ? (userSnap.data()?.integrations || {}) : {};
                if (integrations.google_calendar?.connected) {
                    try {
                        const calResult = await addCalendarEvent(integrations.google_calendar, appt, ownerEmail, db);
                        if (calResult?.eventId) await apptDocRef.update({ googleCalendarEventId: calResult.eventId });
                    } catch (e) { console.error('[Chat/Calendar]', e.message); }
                }
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
                'Reply with "CANCEL" to cancel or "EDIT" to change a detail.',
            ].join('\n');

            return res.json({ success: true, answer, reply: answer });
        }

        const answer = choice?.content?.trim() || 'How can I help you?';
        await logChat(db, businessId, convId, userMsg, answer, true, false);
        return res.json({ success: true, answer, reply: answer });

    } catch (err) {
        console.error('[Chat]', err.message);
        return res.status(500).json({
            success: false,
            answer:  'Something went wrong. Please try again.',
            reply:   'Something went wrong.',
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
// REPORTS & FEEDBACK
// ════════════════════════════════════════════════════════════════════════════
async function handleReportSubmit(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const {
        businessId, conversationId, email, countryCode, mobileNumber,
        writtenReport, botMessage, feedbackRating,
    } = req.body || {};

    if (!businessId || !email || !mobileNumber || !writtenReport || !botMessage)
        return res.status(400).json({ success: false, message: 'Missing required report fields.' });

    try {
        const db = getDb();
        const botSnap = await db.collection('user_bots').doc(businessId).get();
        if (!botSnap.exists) return res.status(404).json({ success: false, message: 'Agent not found.' });

        const b = botSnap.data();
        const owner   = b.owner || '';
        const botName = b.name  || 'Assistant';

        let rating = null;
        if (feedbackRating !== undefined && feedbackRating !== null && feedbackRating !== '') {
            const n = parseInt(feedbackRating, 10);
            if (!isNaN(n) && n >= 1 && n <= 5) rating = n;
        }

        const report = {
            businessId, botName, owner,
            conversationId: conversationId || null,
            email: String(email).trim(),
            countryCode: String(countryCode || '').trim(),
            mobileNumber: String(mobileNumber).trim(),
            writtenReport: String(writtenReport).trim(),
            botMessage: String(botMessage).trim(),
            feedbackRating: rating,
            createdAt: new Date().toISOString(),
        };

        const ref = await db.collection('reports').add(report);
        await db.collection('user_bots').doc(businessId).collection('reports').add({ ...report, globalId: ref.id });

        if (owner) {
            await sendFCMToUser(owner, buildReportNotification(botName, writtenReport))
                .catch(e => console.error('[Report/FCM]', e.message));
        }

        return res.json({ success: true, message: 'Report submitted. Thank you for the feedback.' });
    } catch (err) {
        console.error('[ReportSubmit]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// GOOGLE OAUTH (Calendar)
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
    } catch { return res.status(400).send('Invalid state parameter.'); }

    const clientId     = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri  = process.env.GOOGLE_REDIRECT_URI ||
                         `https://${req.headers.host}/api/oauth/google/callback`;
    if (!clientId || !clientSecret) return res.status(500).send('Missing Google OAuth env vars.');

    try {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body:    new URLSearchParams({
                code, client_id: clientId, client_secret: clientSecret,
                redirect_uri: redirectUri, grant_type: 'authorization_code',
            }),
        });

        const tokens = await tokenRes.json();
        if (tokens.error) return res.status(400).send(`Token error: ${tokens.error_description || tokens.error}`);

        let calendarLabel = email;
        try {
            const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${tokens.access_token}` },
            });
            const profile = await profileRes.json();
            calendarLabel = profile.email || email;
        } catch { /* best-effort */ }

        const db       = getDb();
        const userSnap = await db.collection('users').doc(email).get();
        const existing = userSnap.exists ? (userSnap.data()?.integrations?.google_calendar_accounts || []) : [];

        const newAccount = {
            email:         calendarLabel,
            connected:     true,
            access_token:  tokens.access_token,
            refresh_token: tokens.refresh_token || null,
            expiry_date:   tokens.expires_in
                ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
                : new Date(Date.now() + 3600 * 1000).toISOString(),
            connectedAt: new Date().toISOString(),
        };

        const idx = existing.findIndex(a => a.email === calendarLabel);
        if (idx >= 0) existing[idx] = newAccount; else existing.push(newAccount);

        await db.collection('users').doc(email).set({
            integrations: {
                google_calendar: {
                    connected:     true,
                    access_token:  tokens.access_token,
                    refresh_token: tokens.refresh_token || null,
                    expiry_date:   newAccount.expiry_date,
                },
                google_calendar_accounts: existing,
            },
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
// POST /api/disconnect-calendar  { userEmail, calendarId? , all? }
// Frontend already called this route; it never existed on the backend, so
// clicking "Disconnect" on the calendar card was silently failing. Fixing
// that here since it's part of the same connections page.
// ════════════════════════════════════════════════════════════════════════════
async function handleDisconnectCalendar(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { userEmail, calendarId, all } = req.body || {};
    if (!userEmail) return res.status(400).json({ success: false, message: 'Missing userEmail.' });

    try {
        const db = getDb();
        const userRef = db.collection('users').doc(userEmail);

        if (all) {
            await userRef.set({
                integrations: { google_calendar: null, google_calendar_accounts: [] },
            }, { merge: true });
            return res.json({ success: true, message: 'All Google Calendars disconnected.' });
        }

        if (!calendarId)
            return res.status(400).json({ success: false, message: 'Missing calendarId.' });

        const snap = await userRef.get();
        const existing = snap.exists ? (snap.data()?.integrations?.google_calendar_accounts || []) : [];
        const remaining = existing.filter(a => a.email !== calendarId);

        // Keep the flattened `google_calendar` field (used for booking/availability
        // checks) pointed at whichever account is left, or clear it if none remain.
        const newPrimary = remaining[0] || null;

        await userRef.set({
            integrations: {
                google_calendar_accounts: remaining,
                google_calendar: newPrimary ? {
                    connected:     true,
                    access_token:  newPrimary.access_token,
                    refresh_token: newPrimary.refresh_token || null,
                    expiry_date:   newPrimary.expiry_date,
                } : null,
            },
        }, { merge: true });

        return res.json({ success: true, message: 'Calendar disconnected.' });
    } catch (err) {
        console.error('[DisconnectCalendar]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// FIREBASE PROJECT OAUTH (data source, NOT the calendar flow above)
// Uses standard Google OAuth with Firebase Management + Cloud Platform
// read-only scopes so we can list & later read a client's Firebase projects.
// Requires the SAME Google OAuth client as Calendar (GOOGLE_CLIENT_ID/SECRET)
// registered with these extra scopes enabled on the consent screen.
// ════════════════════════════════════════════════════════════════════════════
async function handleFirebaseProjectOAuth(req, res) {
    const { email, origin } = req.query;
    if (!email) return res.status(400).send('Missing email.');

    const clientId    = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI_FIREBASE ||
                        `https://${req.headers.host}/api/oauth/firebase-project/callback`;
    if (!clientId) return res.status(500).send('Missing GOOGLE_CLIENT_ID env var.');

    const state = Buffer.from(JSON.stringify({ email, origin: origin || null })).toString('base64');
    const url   = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id',     clientId);
    url.searchParams.set('redirect_uri',  redirectUri);
    url.searchParams.set('response_type', 'code');
    // Phase 1 only lists projects — no data-read scope requested yet.
    // (There is no "datastore.readonly" scope; reading Firestore/RTDB data
    // for real in a later phase will require the broader
    // 'https://www.googleapis.com/auth/cloud-platform' or
    // 'https://www.googleapis.com/auth/datastore' scope, which needs a
    // fresh consent + re-connect once that phase is built.)
    url.searchParams.set('scope', [
        'https://www.googleapis.com/auth/firebase.readonly',
        'https://www.googleapis.com/auth/cloud-platform.read-only',
    ].join(' '));
    url.searchParams.set('access_type',   'offline');
    url.searchParams.set('prompt',        'consent');
    url.searchParams.set('state',         state);

    return res.redirect(302, url.toString());
}

async function handleFirebaseProjectCallback(req, res) {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`OAuth error: ${error}`);
    if (!code || !state) return res.status(400).send('Missing code or state.');

    let email = '', origin = null;
    try {
        const parsed = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
        email  = parsed.email;
        origin = parsed.origin;
    } catch { return res.status(400).send('Invalid state parameter.'); }

    const clientId     = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri  = process.env.GOOGLE_REDIRECT_URI_FIREBASE ||
                         `https://${req.headers.host}/api/oauth/firebase-project/callback`;
    if (!clientId || !clientSecret) return res.status(500).send('Missing Google OAuth env vars.');

    try {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body:    new URLSearchParams({
                code, client_id: clientId, client_secret: clientSecret,
                redirect_uri: redirectUri, grant_type: 'authorization_code',
            }),
        });
        const tokens = await tokenRes.json();
        if (tokens.error) return res.status(400).send(`Token error: ${tokens.error_description || tokens.error}`);

        let accountLabel = email;
        try {
            const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${tokens.access_token}` },
            });
            const profile = await profileRes.json();
            accountLabel = profile.email || email;
        } catch { /* best-effort */ }

        const db = getDb();
        await db.collection('users').doc(email).set({
            integrations: {
                firebase_project: {
                    connected:     true,
                    accountLabel,
                    access_token:  tokens.access_token,
                    refresh_token: tokens.refresh_token || null,
                    expiry_date:   tokens.expires_in
                        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
                        : new Date(Date.now() + 3600 * 1000).toISOString(),
                    connectedAt: new Date().toISOString(),
                },
            },
        }, { merge: true });

        const appUrl = origin || process.env.APP_URL ||
                       `https://${req.headers.host.replace('comex-backend', 'cometchat-ai-platform').replace('.vercel.app', '.web.app')}`;
        return res.redirect(302, `${appUrl}?firebase_project_connected=1`);
    } catch (err) {
        console.error('[OAuth/FirebaseProject]', err.message);
        return res.status(500).send(`Server error: ${err.message}`);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// SUPABASE OAUTH (data source)
// Requires a Supabase OAuth app registered at https://supabase.com/dashboard/org/_/apps
// with SUPABASE_CLIENT_ID / SUPABASE_CLIENT_SECRET env vars.
// ════════════════════════════════════════════════════════════════════════════
async function handleSupabaseOAuth(req, res) {
    const { email, origin } = req.query;
    if (!email) return res.status(400).send('Missing email.');

    const clientId    = process.env.SUPABASE_CLIENT_ID;
    const redirectUri = process.env.SUPABASE_REDIRECT_URI ||
                        `https://${req.headers.host}/api/oauth/supabase/callback`;
    if (!clientId) return res.status(500).send('Missing SUPABASE_CLIENT_ID env var.');

    const state = Buffer.from(JSON.stringify({ email, origin: origin || null })).toString('base64');
    const url   = new URL('https://api.supabase.com/v1/oauth/authorize');
    url.searchParams.set('client_id',     clientId);
    url.searchParams.set('redirect_uri',  redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state',         state);

    return res.redirect(302, url.toString());
}

async function handleSupabaseCallback(req, res) {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`OAuth error: ${error}`);
    if (!code || !state) return res.status(400).send('Missing code or state.');

    let email = '', origin = null;
    try {
        const parsed = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
        email  = parsed.email;
        origin = parsed.origin;
    } catch { return res.status(400).send('Invalid state parameter.'); }

    const clientId     = process.env.SUPABASE_CLIENT_ID;
    const clientSecret  = process.env.SUPABASE_CLIENT_SECRET;
    const redirectUri   = process.env.SUPABASE_REDIRECT_URI ||
                          `https://${req.headers.host}/api/oauth/supabase/callback`;
    if (!clientId || !clientSecret) return res.status(500).send('Missing Supabase OAuth env vars.');

    try {
        const tokenRes = await fetch('https://api.supabase.com/v1/oauth/token', {
            method:  'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
            },
            body: new URLSearchParams({
                code, redirect_uri: redirectUri, grant_type: 'authorization_code',
            }),
        });
        const tokens = await tokenRes.json();
        if (tokens.error) return res.status(400).send(`Token error: ${tokens.error_description || tokens.error}`);

        const db = getDb();
        await db.collection('users').doc(email).set({
            integrations: {
                supabase: {
                    connected:     true,
                    access_token:  tokens.access_token,
                    refresh_token: tokens.refresh_token || null,
                    expiry_date:   tokens.expires_in
                        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
                        : new Date(Date.now() + 3600 * 1000).toISOString(),
                    connectedAt: new Date().toISOString(),
                },
            },
        }, { merge: true });

        const appUrl = origin || process.env.APP_URL ||
                       `https://${req.headers.host.replace('comex-backend', 'cometchat-ai-platform').replace('.vercel.app', '.web.app')}`;
        return res.redirect(302, `${appUrl}?supabase_connected=1`);
    } catch (err) {
        console.error('[OAuth/Supabase]', err.message);
        return res.status(500).send(`Server error: ${err.message}`);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/integrations/list-projects?service=firebase|supabase&ownerEmail=...
// Lists the projects available under the connected account so the "Configure
// New Agent" flow can offer a project picker.
// ════════════════════════════════════════════════════════════════════════════
async function handleListProjects(req, res) {
    const { service, ownerEmail } = req.query;
    if (!service || !ownerEmail)
        return res.status(400).json({ success: false, message: 'Missing service or ownerEmail.' });

    try {
        const db = getDb();
        const userSnap = await db.collection('users').doc(ownerEmail).get();
        const integrations = userSnap.exists ? (userSnap.data()?.integrations || {}) : {};

        if (service === 'firebase') {
            const fb = integrations.firebase_project;
            if (!fb?.connected) return res.status(400).json({ success: false, message: 'Firebase not connected.' });

            const accessToken = await refreshGenericGoogleToken(fb, ownerEmail, db, 'firebase_project');
            const r = await fetch('https://firebase.googleapis.com/v1beta1/projects', {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (!r.ok) {
                const errBody = await r.text();
                return res.status(502).json({ success: false, message: `Firebase API error: ${errBody}` });
            }
            const data = await r.json();
            const projects = (data.results || []).map(p => ({
                id:   p.projectId,
                name: p.displayName || p.projectId,
            }));
            return res.json({ success: true, projects });
        }

        if (service === 'supabase') {
            const sb = integrations.supabase;
            if (!sb?.connected) return res.status(400).json({ success: false, message: 'Supabase not connected.' });

            const r = await fetch('https://api.supabase.com/v1/projects', {
                headers: { Authorization: `Bearer ${sb.access_token}` },
            });
            if (!r.ok) {
                const errBody = await r.text();
                return res.status(502).json({ success: false, message: `Supabase API error: ${errBody}` });
            }
            const data = await r.json();
            const projects = (Array.isArray(data) ? data : []).map(p => ({
                id:   p.id,
                name: p.name || p.id,
            }));
            return res.json({ success: true, projects });
        }

        return res.status(400).json({ success: false, message: `Unknown service: ${service}` });
    } catch (err) {
        console.error('[ListProjects]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/integrations/disconnect-database  { ownerEmail, service }
// ════════════════════════════════════════════════════════════════════════════
async function handleDisconnectDatabase(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { ownerEmail, service } = req.body || {};
    if (!ownerEmail || !service)
        return res.status(400).json({ success: false, message: 'Missing ownerEmail or service.' });

    const fieldMap = { firebase: 'firebase_project', supabase: 'supabase' };
    const field = fieldMap[service];
    if (!field) return res.status(400).json({ success: false, message: `Unknown service: ${service}` });

    try {
        const db = getDb();
        await db.collection('users').doc(ownerEmail).set({
            integrations: { [field]: null },
        }, { merge: true });
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}

/** Generic Google token refresh, shared by any integration stored under integrations.<key> with the same token shape. */
async function refreshGenericGoogleToken(authObj, ownerEmail, db, key) {
    let accessToken = authObj.access_token;
    if (authObj.refresh_token && authObj.expiry_date) {
        const expiryMs = new Date(authObj.expiry_date).getTime();
        if (!isNaN(expiryMs) && expiryMs < Date.now() + 60000) {
            const r = await fetch('https://oauth2.googleapis.com/token', {
                method:  'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body:    new URLSearchParams({
                    client_id:     process.env.GOOGLE_CLIENT_ID,
                    client_secret: process.env.GOOGLE_CLIENT_SECRET,
                    refresh_token: authObj.refresh_token,
                    grant_type:    'refresh_token',
                }),
            });
            const t = await r.json();
            if (t.access_token) {
                accessToken = t.access_token;
                await db.collection('users').doc(ownerEmail).update({
                    [`integrations.${key}.access_token`]: t.access_token,
                    [`integrations.${key}.expiry_date`]:
                        new Date(Date.now() + (t.expires_in || 3500) * 1000).toISOString(),
                });
            }
        }
    }
    return accessToken;
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

async function logChat(db, businessId, convId, question, answer, isGenuineQuery, isLeadCaptured) {
    try {
        await db.collection('user_bots').doc(businessId).collection('chats').add({
            conversationId: convId, question, answer, isGenuineQuery, isLeadCaptured,
            createdAt: new Date().toISOString(),
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
        january:0,february:1,march:2,april:3,may:4,june:5,
        july:6,august:7,september:8,october:9,november:10,december:11,
        jan:0,feb:1,mar:2,apr:3,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11,
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

    const days    = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
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
        let h   = parseInt(m[1], 10);
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
                method:  'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body:    new URLSearchParams({
                    client_id:     process.env.GOOGLE_CLIENT_ID,
                    client_secret: process.env.GOOGLE_CLIENT_SECRET,
                    refresh_token: googleAuth.refresh_token,
                    grant_type:    'refresh_token',
                }),
            });
            const t = await r.json();
            if (t.access_token) {
                accessToken = t.access_token;
                await db.collection('users').doc(ownerEmail).update({
                    'integrations.google_calendar.access_token': t.access_token,
                    'integrations.google_calendar.expiry_date':
                        new Date(Date.now() + (t.expires_in || 3500) * 1000).toISOString(),
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
                hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false,
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

        const events   = (await r.json()).items || [];
        const isBooked = events.some(ev => {
            const evS = new Date(ev.start?.dateTime || ev.start?.date);
            const evE = new Date(ev.end?.dateTime   || ev.end?.date);
            return startUTC < evE && endUTC > evS;
        });
        if (!isBooked) return { available: true };

        const booked      = events.map(ev => ({
            start: new Date(ev.start?.dateTime || ev.start?.date),
            end:   new Date(ev.end?.dateTime   || ev.end?.date),
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
        method:  'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
            summary:     `Appointment: ${appt.customerName}`,
            description: `Contact: ${appt.contactInfo}\nBooked via Comex AI`,
            start: { dateTime: localStart, timeZone },
            end:   { dateTime: localEnd,   timeZone },
        }),
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
        method:  'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
            summary:     `Appointment: ${appt.customerName}`,
            description: `Contact: ${appt.contactInfo}\nBooked via Comex AI`,
            start: { dateTime: localStart, timeZone },
            end:   { dateTime: localEnd,   timeZone },
        }),
    });
    if (!r.ok) {
        const d = await r.json();
        console.error('[Calendar] Update error:', d.error?.message);
    }
}
