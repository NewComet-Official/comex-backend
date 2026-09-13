import admin from 'firebase-admin';
import Groq from 'groq-sdk';
import crypto from 'crypto';
import { Resend } from 'resend';

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
    'qwen-3.6-27b':       { id: 'qwen/qwen3.6-27b',        provider: 'groq',    label: 'Qwen 3.6 27B'            },
    'llama-3.1-8b':      { id: 'llama-3.1-8b-instant',    provider: 'groq',    label: 'Meta LLaMA 3.1 8B (Fast)' },
    'gpt-oss-120b':      { id: 'openai/gpt-oss-120b',     provider: 'groq',    label: 'OpenAI GPT-OSS 120B'     },
    'gpt-oss-20b':       { id: 'openai/gpt-oss-20b',      provider: 'groq',    label: 'OpenAI GPT-OSS 20B (Fast)' },
    'mistral-large':     { id: 'mistral-large-latest',    provider: 'mistral', label: 'Mistral Large'           },
    'mistral-small':     { id: 'mistral-small-latest',    provider: 'mistral', label: 'Mistral Small (Fast)'    },
    'gemini-2.5-flash':  { id: 'gemini-2.5-flash',        provider: 'google',  label: 'Gemini 2.5 Flash'        },
};

const DEFAULT_MODEL_KEY = 'qwen-3.6-27b';

// ═══ MULTI-AGENT ROUTER ═══
async function routeToSubAgent(modelKey, userMsg, subAgents) {
    if (!subAgents?.length) return null;
    const listText = subAgents.map(a => `${a.id}: ${a.description || a.name}`).join('\n');
    try {
        const choice = await callLLM({
            modelKey,
            messages: [
                { role: 'system', content: `You are a routing classifier. Pick the ID of the single best-matching specialized agent for the user's message below. Reply with ONLY the agent ID and nothing else.\n\nAgents:\n${listText}` },
                { role: 'user', content: userMsg },
            ],
        });
        const picked = (choice?.content || '').trim().toLowerCase().replace(/[^a-z0-9_\-]/g, '');
        return subAgents.find(a => a.id.toLowerCase() === picked) || null;
    } catch (e) {
        console.error('[SubAgentRouter]', e.message);
        return null;
    }
}

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

// ════════════════════════════════════════════════════════════════════════════
// AUTONOMOUS ACTIONS — TOOL CALLING & WEBHOOK EXECUTION
// ════════════════════════════════════════════════════════════════════════════

// Sanitizes a user-configured action name into a safe function-calling identifier.
function sanitizeActionFunctionName(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .substring(0, 64) || 'action';
}

// Resolves the callable function name for a configured agent action, preferring
// the stored id (set client-side from the action name) and falling back to a
// freshly sanitized version of the name if the id is missing/stale.
function actionFunctionName(action) {
    return action.id ? sanitizeActionFunctionName(action.id) : sanitizeActionFunctionName(action.name);
}

// Converts the user-configured `agentActions` array (stored on the bot doc)
// into standard OpenAI/Groq/Mistral/Gemini-compatible `tools` function
// definitions the LLM can choose to call.
function buildAgentActionToolDefs(agentActions) {
    return (Array.isArray(agentActions) ? agentActions : [])
        .filter(a => a && a.name && a.url)
        .map(a => {
            const properties = {};
            const required = [];
            (Array.isArray(a.parameters) ? a.parameters : []).forEach(p => {
                if (!p || !p.name) return;
                const jsonType = p.type === 'number' ? 'number' : (p.type === 'boolean' ? 'boolean' : 'string');
                properties[p.name] = {
                    type: jsonType,
                    description: p.description || `The ${p.name} parameter.`,
                };
                if (p.required) required.push(p.name);
            });

            return {
                type: 'function',
                function: {
                    name: actionFunctionName(a),
                    description: a.description || `Executes the "${a.name}" action against an external system.`,
                    parameters: {
                        type: 'object',
                        properties,
                        required,
                    },
                },
            };
        });
}

// Replaces `:param_name` path segments in a URL template with real values
// extracted by the LLM (e.g. "https://api.site.com/orders/:order_id" with
// { order_id: "1234" } becomes "https://api.site.com/orders/1234").
function formatActionUrl(urlTemplate, params) {
    let url = String(urlTemplate || '');
    const usedKeys = new Set();
    Object.keys(params || {}).forEach(key => {
        const token = `:${key}`;
        if (url.includes(token)) {
            url = url.split(token).join(encodeURIComponent(String(params[key])));
            usedKeys.add(key);
        }
    });
    return { url, usedKeys };
}

// Executes a single configured autonomous action (webhook/API call) using the
// parameters the LLM extracted from the conversation. Supports GET, POST,
// PUT, DELETE, custom headers (e.g. Authorization / Bearer tokens), dynamic
// URL path substitution, and query-string / JSON-body param placement.
async function executeAgentAction(action, extractedParams) {
    const params = extractedParams && typeof extractedParams === 'object' ? extractedParams : {};
    const method = String(action.method || 'GET').toUpperCase();
    const actionLabel = action.name || 'action';

    try {
        const { url: pathFormattedUrl, usedKeys } = formatActionUrl(action.url, params);

        // Any parameters NOT consumed by the URL path template are sent either
        // as query-string params (GET/DELETE) or as a JSON body (POST/PUT).
        const remainingParams = {};
        Object.keys(params).forEach(key => {
            if (!usedKeys.has(key)) remainingParams[key] = params[key];
        });

        const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
        (Array.isArray(action.headers) ? action.headers : []).forEach(h => {
            if (h && h.key) headers[h.key] = h.value !== undefined ? h.value : '';
        });

        let finalUrl = pathFormattedUrl;
        const fetchOptions = { method, headers, signal: AbortSignal.timeout(12000) };

        if (method === 'GET' || method === 'DELETE') {
            const qs = new URLSearchParams();
            Object.entries(remainingParams).forEach(([k, v]) => {
                if (v !== undefined && v !== null) qs.append(k, String(v));
            });
            const qsStr = qs.toString();
            if (qsStr) finalUrl += (finalUrl.includes('?') ? '&' : '?') + qsStr;
        } else {
            fetchOptions.body = JSON.stringify(remainingParams);
        }

        const r = await fetch(finalUrl, fetchOptions);
        const rawText = await r.text();
        let parsedBody = rawText;
        try { parsedBody = rawText ? JSON.parse(rawText) : null; } catch { /* leave as raw text */ }

        if (!r.ok) {
            return {
                success: false,
                status: r.status,
                error: `Action "${actionLabel}" failed with HTTP ${r.status}.`,
                data: parsedBody,
            };
        }

        return { success: true, status: r.status, data: parsedBody };
    } catch (err) {
        const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
        return {
            success: false,
            error: isTimeout
                ? `Action "${actionLabel}" timed out while contacting the external system.`
                : `Action "${actionLabel}" could not be completed: ${err.message}`,
        };
    }
}

// Runs every requested tool call for a batch of configured agent actions and
// returns { toolCallId, functionName, result } entries ready to be appended
// back into the conversation as `tool` role messages.
async function runAgentActionToolCalls(toolCalls, agentActions) {
    const results = [];
    for (const tc of toolCalls) {
        const fnName = tc.function?.name;
        const actionDef = (agentActions || []).find(a => actionFunctionName(a) === fnName);

        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }

        let result;
        if (actionDef) {
            result = await executeAgentAction(actionDef, args);
        } else {
            result = { success: false, error: `No configured action matches "${fnName}".` };
        }

        results.push({ toolCallId: tc.id, functionName: fnName, result });
    }
    return results;
}

// Some reasoning-capable open models (Qwen, DeepSeek-style, etc.) emit a
// <think>...</think> block ahead of their real answer when called via the
// raw chat-completions API — Groq doesn't strip this for us. Remove it
// before the content is ever shown to a user or parsed for tool-call JSON.
function stripThinkingTags(text) {
    if (!text) return text;
    return text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        // Handles the rarer case of a closing tag with no matching opener
        // (can happen if the model's reasoning gets truncated).
        .replace(/^[\s\S]*?<\/think>/i, '')
        .trim();
}

async function callLLM({ modelKey, messages, toolChoice, allFieldsPresent, enableBookingTool, extraTools }) {
    const entry = MODEL_REGISTRY[modelKey] || MODEL_REGISTRY[DEFAULT_MODEL_KEY];

    const tools = [
        ...(enableBookingTool ? [BOOKING_TOOL_DEF] : []),
        ...(Array.isArray(extraTools) ? extraTools : []),
    ];
    const hasTools = tools.length > 0;

    let toolChoiceValue;
    if (toolChoice) {
        toolChoiceValue = toolChoice;
    } else if (enableBookingTool && allFieldsPresent) {
        toolChoiceValue = { type: 'function', function: { name: 'appointmentBooking' } };
    } else if (hasTools) {
        toolChoiceValue = 'auto';
    }

    if (entry.provider === 'groq') {
        if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set.');
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const completion = await groq.chat.completions.create({
            model:       entry.id,
            messages,
            ...(hasTools ? { tools, tool_choice: toolChoiceValue } : {}),
            temperature: 0.3,
            max_tokens:  600,
        });
        const msg = completion.choices[0]?.message || {};
        if (msg.content) msg.content = stripThinkingTags(msg.content);
        return msg;
    }

    if (entry.provider === 'mistral') {
        const apiKey = process.env.MISTRAL_API_KEY;
        if (!apiKey) throw new Error('MISTRAL_API_KEY not set.');

        const body = {
            model:       entry.id,
            messages,
            ...(hasTools ? { tools, tool_choice: toolChoiceValue } : {}),
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

        if (msg.content) msg.content = stripThinkingTags(msg.content);
        return msg;
    }

    if (entry.provider === 'google') {
        const apiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
        if (!apiKey) throw new Error('GOOGLE_AI_STUDIO_API_KEY not set.');

        const url = `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`;

        const body = {
            model:       entry.id,
            messages,
            ...(hasTools ? { tools, tool_choice: toolChoiceValue } : {}),
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
        const msg = data.choices?.[0]?.message || {};
        if (msg.content) msg.content = stripThinkingTags(msg.content);
        return msg;
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
    if (path === '/api/analytics/advanced')       return handleAdvancedAnalytics(req, res);
    if (path === '/api/models')                   return handleModels(req, res);
    if (path === '/api/fcm-register-token')       return handleFCMRegisterToken(req, res);
    if (path === '/api/fcm-remove-token')         return handleFCMRemoveToken(req, res);
    if (path === '/api/fcm-test-notification')    return handleFCMTestNotification(req, res);
    if (path === '/api/appointment/cancel')       return handleAppointmentCancel(req, res);
    if (path === '/api/appointment/edit')         return handleAppointmentEdit(req, res);
    if (path === '/api/oauth/google')             return handleGoogleOAuth(req, res);
    if (path === '/api/oauth/google/callback')    return handleGoogleCallback(req, res);
    if (path === '/api/disconnect-calendar')      return handleDisconnectCalendar(req, res);
    if (path === '/api/integrations/toggle-calendar-account') return handleToggleCalendarAccount(req, res);
    if (path === '/api/report/submit')            return handleReportSubmit(req, res);
    if (path === '/api/promo/validate')           return handlePromoValidate(req, res);
    if (path === '/api/bot/delete-cascade')       return handleBotDeleteCascade(req, res);
    if (path === '/api/account/delete-cascade')   return handleAccountDeleteCascade(req, res);
    if (path === '/api/account/update-email')     return handleAccountChangeEmail(req, res);
    if (path === '/api/account/check-exists')     return handleCheckAccountExists(req, res);
    if (path === '/api/password-reset/request') return handlePasswordResetRequest(req, res);
    if (path === '/api/password-reset/verify')  return handlePasswordResetVerify(req, res);
    if (path === '/api/password-reset/confirm') return handlePasswordResetConfirm(req, res);


    // ── Enterprise dynamic pricing (Whop) ──────────────────────────────────
    if (path === '/api/enterprise/create-checkout') return handleEnterpriseCreateCheckout(req, res);
    if (path === '/api/webhooks/whop')               return handleWhopWebhook(req, res);

    // ── Database source integrations (Firebase Project / Supabase) ────────
    if (path === '/api/oauth/firebase-project')          return handleFirebaseProjectOAuth(req, res);
    if (path === '/api/oauth/firebase-project/callback')  return handleFirebaseProjectCallback(req, res);
    if (path === '/api/oauth/supabase')                   return handleSupabaseOAuth(req, res);
    if (path === '/api/oauth/supabase/callback')          return handleSupabaseCallback(req, res);
    if (path === '/api/integrations/list-projects')       return handleListProjects(req, res);
    if (path === '/api/integrations/disconnect-database')  return handleDisconnectDatabase(req, res);

    // ── Design source integrations (Canva / Figma) ─────────────────────────
    if (path === '/api/oauth/figma')               return handleFigmaOAuth(req, res);
    if (path === '/api/oauth/figma/callback')      return handleFigmaCallback(req, res);
    if (path === '/api/oauth/canva')               return handleCanvaOAuth(req, res);
    if (path === '/api/oauth/canva/callback')      return handleCanvaCallback(req, res);
    if (path === '/api/design/import')             return handleDesignImport(req, res);

    // ── Company / Employee accounts ────────────────────────────────────────
    if (path === '/api/company/check-username')           return handleCompanyCheckUsername(req, res);
    if (path === '/api/company/setup')                     return handleCompanySetup(req, res);
    if (path === '/api/company/join-code')                 return handleCompanyJoinCode(req, res);
    if (path === '/api/company/join-code/regenerate'       ) return handleCompanyJoinCodeRegenerate(req, res);
    if (path === '/api/employee/verify-and-connect')      return handleEmployeeVerifyAndConnect(req, res);
    if (path === '/api/company/employees/list')           return handleCompanyEmployeesList(req, res);
    if (path === '/api/company/employees/remove')         return handleCompanyEmployeeRemove(req, res);
    if (path === '/api/company/employees/disable')        return handleCompanyEmployeeDisable(req, res);
    if (path === '/api/company/employees/delete')         return handleCompanyEmployeeDelete(req, res);
    if (path === '/api/account/update-photo')             return handleUpdateProfilePhoto(req, res);

    // ── Human handoff ───────────────────────────────────────────────────────
    if (path === '/api/human/list')            return handleHumanList(req, res);
    if (path === '/api/human/connect')         return handleHumanConnect(req, res);
    if (path === '/api/human/send-message')    return handleHumanSendMessage(req, res);
    if (path === '/api/human/poll')            return handleHumanPoll(req, res);
    if (path === '/api/human/close')           return handleHumanClose(req, res);

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
// ENTERPRISE DYNAMIC PRICING (WHOP)
// ════════════════════════════════════════════════════════════════════════════

const ENTERPRISE_PRICING = {
    basePrice:        499,     // $499/mo base, includes baseCredits + baseAgents + baseSeats
    baseCredits:      45000,   creditOverageRate: 0.010,  maxCredits: 2000000,
    baseAgents:       10,      agentOverageRate:  15,     maxAgents:  5000,
    baseSeats:        10,      seatOverageRate:   10,     maxSeats:   5000,
};

// Server-side source of truth for the price — NEVER trust a client-sent
// dollar amount. Re-derives price from credits + agents + seats every time.
function calculateEnterprisePrice(rawCreditPool, rawAgentCount, rawSeatCount) {
    let credits = Math.round(Number(rawCreditPool) || 0);
    credits = Math.max(ENTERPRISE_PRICING.baseCredits, Math.min(ENTERPRISE_PRICING.maxCredits, credits));

    let agents = Math.round(Number(rawAgentCount) || ENTERPRISE_PRICING.baseAgents);
    agents = Math.max(ENTERPRISE_PRICING.baseAgents, Math.min(ENTERPRISE_PRICING.maxAgents, agents));

    let seats = Math.round(Number(rawSeatCount) || ENTERPRISE_PRICING.baseSeats);
    seats = Math.max(ENTERPRISE_PRICING.baseSeats, Math.min(ENTERPRISE_PRICING.maxSeats, seats));

    const creditsCost = Math.max(0, credits - ENTERPRISE_PRICING.baseCredits) * ENTERPRISE_PRICING.creditOverageRate;
    const agentsCost  = Math.max(0, agents  - ENTERPRISE_PRICING.baseAgents)  * ENTERPRISE_PRICING.agentOverageRate;
    const seatsCost   = Math.max(0, seats   - ENTERPRISE_PRICING.baseSeats)   * ENTERPRISE_PRICING.seatOverageRate;

    const price = ENTERPRISE_PRICING.basePrice + creditsCost + agentsCost + seatsCost;
    return { credits, agents, seats, price: Math.round(price * 100) / 100 };
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/enterprise/create-checkout  { email, companyId, creditPool, agentCount, seatCount }
// Server re-validates the price, then asks Whop for an exact-amount dynamic
// checkout session and returns the URL to redirect the user to.
// ════════════════════════════════════════════════════════════════════════════
async function handleEnterpriseCreateCheckout(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { email, companyId, creditPool, agentCount, seatCount } = req.body || {};
    if (!email || creditPool === undefined || creditPool === null)
        return res.status(400).json({ success: false, message: 'Missing email or creditPool.' });

    const { credits, agents, seats, price } = calculateEnterprisePrice(creditPool, agentCount, seatCount);
    if (!(price >= ENTERPRISE_PRICING.basePrice))
        return res.status(400).json({ success: false, message: 'Invalid plan configuration.' });

    const whopApiKey    = process.env.WHOP_API_KEY;
    const whopCompanyId = process.env.WHOP_COMPANY_ID;          // biz_xxxxxxxxxxxxxx
    const whopProductId = process.env.WHOP_ENTERPRISE_PRODUCT_ID; // prod_xxxxxxxxxxxxx
    if (!whopApiKey || !whopCompanyId || !whopProductId) {
        return res.status(500).json({
            success: false,
            message: 'Enterprise checkout is not configured yet. Set WHOP_API_KEY, WHOP_COMPANY_ID, and WHOP_ENTERPRISE_PRODUCT_ID.',
        });
    }

    try {
        const appUrl = process.env.APP_URL || `https://${req.headers.host}`;

        // DEBUG: confirm exactly which IDs are being sent to Whop (never log
        // the API key itself). A 404 here means one of these two doesn't
        // resolve under the account that owns WHOP_API_KEY.
        console.log('[Enterprise/CreateCheckout] company_id=', whopCompanyId, 'product_id=', whopProductId, 'price=', price);

        // Whop's REST API (api.whop.com/api/v1) has no "custom_amount" override
        // for a fixed plan_id. Dynamic pricing = a checkout configuration with
        // an inline plan whose renewal_price is the amount computed above.
        const r = await fetch('https://api.whop.com/api/v1/checkout_configurations', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${whopApiKey}`,
            },
            body: JSON.stringify({
                mode: 'payment',
                metadata: {
                    company_id: companyId || email,
                    owner_email: email,
                    credit_pool: credits,
                    agent_count: agents,
                    seat_count: seats,
                    tier: 'enterprise',
                },
                redirect_url: `${appUrl}/dashboard?enterprise_checkout=started`,
                plan: {
                    company_id: whopCompanyId,
                    product_id: whopProductId,
                    currency: 'usd',
                    plan_type: 'renewal',
                    billing_period: 30,
                    renewal_price: price,
                    visibility: 'hidden',
                },
            }),
        });

        if (!r.ok) {
            const errText = await r.text();
            // Surface the exact IDs in the thrown message too, so this shows
            // up in Vercel's function log for the failed request without
            // needing to cross-reference the earlier console.log line.
            throw new Error(`Whop checkout configuration failed (HTTP ${r.status}) [company_id=${whopCompanyId}, product_id=${whopProductId}]: ${errText.substring(0, 300)}`);
        }

        const data = await r.json();
        let checkoutUrl = data.purchase_url;
        if (checkoutUrl && !/^https?:\/\//i.test(checkoutUrl)) {
            checkoutUrl = `https://whop.com${checkoutUrl.startsWith('/') ? '' : '/'}${checkoutUrl}`;
        }
        if (!checkoutUrl) throw new Error('Whop did not return a purchase URL.');

        try {
            const db = getDb();
            await db.collection('enterprise_checkout_requests').add({
                ownerEmail: email, companyId: companyId || email,
                creditPool: credits, agentCount: agents, seatCount: seats,
                price, whopCheckoutConfigId: data.id || null,
                createdAt: new Date().toISOString(),
            });
        } catch (e) { /* best-effort logging only */ }

        return res.json({ success: true, checkoutUrl, credits, agents, seats, price });
    } catch (err) {
        console.error('[Enterprise/CreateCheckout]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/webhooks/whop — automated provisioning / downgrade on payment events
// ════════════════════════════════════════════════════════════════════════════
async function handleWhopWebhook(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    // Verify the webhook signature if Whop supplied one and you've set
    // WHOP_WEBHOOK_SECRET. Adjust the header name / HMAC scheme to match
    // whatever Whop documents for your account — this is the common pattern.
    const signature = req.headers['x-whop-signature'];
    const webhookSecret = process.env.WHOP_WEBHOOK_SECRET;
    if (webhookSecret && signature) {
        try {
            const rawBody = JSON.stringify(req.body);
            const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
            if (expected !== signature) {
                console.warn('[Whop/Webhook] Signature mismatch — rejecting.');
                return res.status(401).json({ success: false, message: 'Invalid signature.' });
            }
        } catch (e) {
            console.warn('[Whop/Webhook] Signature check errored, rejecting to be safe:', e.message);
            return res.status(401).json({ success: false, message: 'Signature verification failed.' });
        }
    }

    const event    = req.body || {};
    const type     = event.type || event.action;
    const data     = event.data || {};
    const metadata = data.metadata || {};



    try {
        const db = getDb();
        const ownerEmail = metadata.owner_email;
        const creditPool = parseInt(metadata.credit_pool, 10) || ENTERPRISE_PRICING.baseCredits;
        const agentCount = parseInt(metadata.agent_count, 10) || ENTERPRISE_PRICING.baseAgents;
        const seatCount  = parseInt(metadata.seat_count, 10)  || ENTERPRISE_PRICING.baseSeats;

        if (!ownerEmail) {
            console.warn('[Whop/Webhook] Event missing owner_email metadata, ignoring:', type);
            return res.json({ success: true });
        }

        if (type === 'membership.went_valid' || type === 'payment.succeeded') {
            await db.collection('users').doc(ownerEmail).set({
                planTier: 'enterprise',
                planUnlockedByPromo: false,
                enterprise: {
                    monthlyCredits: creditPool,
                    maxAgents: agentCount, // purchased count, not unlimited — re-run checkout to scale up
                    maxSeats: seatCount,
                    integrations: {
                        firebase: true, supabase: true, canva: true, figma: true,
                        google_calendar: true, push_alerts: true,
                    },
                    status: 'active',
                    whopMembershipId: data.id || null,
                    activatedAt: new Date().toISOString(),
                },
            }, { merge: true });
            console.log(`[Whop/Webhook] Enterprise activated for ${ownerEmail} — ${creditPool} credits, ${agentCount} agents, ${seatCount} seats/mo.`);
        } else if (type === 'membership.went_invalid') {
            await db.collection('users').doc(ownerEmail).set({
                planTier: 'free',
                enterprise: { status: 'cancelled', cancelledAt: new Date().toISOString() },
            }, { merge: true });
            console.log(`[Whop/Webhook] Enterprise cancelled for ${ownerEmail}, downgraded to free.`);
        } else {
            console.log(`[Whop/Webhook] Unhandled event type: ${type}`);
        }

        return res.json({ success: true });
    } catch (err) {
        console.error('[Whop/Webhook]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// ADVANCED ANALYTICS — fallback rate, sentiment, drop-off, topic clustering
// ════════════════════════════════════════════════════════════════════════════

const PERIOD_MS = {
    week:         7   * 24 * 60 * 60 * 1000,
    last15days:   15  * 24 * 60 * 60 * 1000,
    month:        30  * 24 * 60 * 60 * 1000,
    last6months:  182 * 24 * 60 * 60 * 1000,
    year:         365 * 24 * 60 * 60 * 1000,
    last5years:   5 * 365 * 24 * 60 * 60 * 1000,
};

function getPeriodStart(period) {
    const now = new Date();
    if (period === 'today') {
        const d = new Date(now);
        d.setHours(0, 0, 0, 0);
        return d;
    }
    const ms = PERIOD_MS[period] || PERIOD_MS.week;
    return new Date(now.getTime() - ms);
}

const FALLBACK_PATTERNS = /don't have (that|this) information|do not have (that|this) information|can only help with questions about this business|i'?m not sure|i am not sure|couldn't find|could not find|don't know the answer|flagged this for our team|speak with a person|connect (you )?(with|to) (a )?(human|team|agent)|live handoff isn't available|isn't available here right now/i;

function detectFallback(answer) {
    return FALLBACK_PATTERNS.test(String(answer || ''));
}

// Lightweight lexicon-based sentiment scorer (no extra LLM call per message —
// keeps chat logging fast/cheap). Score range: -1 (negative) .. 1 (positive).
const SENTIMENT_NEG = ['angry','frustrat','terrible','worst','hate','awful','useless','broken','disappoint','annoyed','not working',"doesn't work","isn't working",'bad experience','waste of time','horrible','stupid','ridiculous','unacceptable','confusing','complicated','slow','never works','give up','done with this','so bad','no help','not helpful','ridiculous','scam','rude'];
const SENTIMENT_POS = ['thank','thanks','great','awesome','perfect','love','excellent','helpful','amazing','good job','appreciate','wonderful','fantastic','nice','cool','works great','exactly what','solved','sorted','happy','glad'];

function computeSentiment(text) {
    const t = String(text || '').toLowerCase();
    let score = 0;
    SENTIMENT_NEG.forEach(w => { if (t.includes(w)) score -= 1; });
    SENTIMENT_POS.forEach(w => { if (t.includes(w)) score += 1; });
    if (t.includes('!') && score < 0) score -= 0.5; // exclamation amplifies frustration
    const clamped = Math.max(-1, Math.min(1, score / 3));
    let label = 'neutral';
    if (clamped > 0.12) label = 'positive';
    else if (clamped < -0.12) label = 'negative';
    return { label, score: Math.round(clamped * 100) / 100 };
}

const CLUSTER_STOPWORDS = new Set(['the','a','an','is','are','do','does','did','how','what','can','i','you','your','my','to','of','for','in','on','with','and','or','it','this','that','me','about','please','would','like','need','want','have','has','had','be','was','were','will','if','when','where','why','who','which','there','their','they','we','us','our','am','tell','know','get','got','just','also','some','any','one','not','from','at','as','so','but','than','then','out']);

function clusterByKeyword(questions) {
    const clusters = {};
    (questions || []).forEach(q => {
        const words = String(q || '').toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2 && !CLUSTER_STOPWORDS.has(w));
        if (!words.length) return;
        const key = [...words].sort((a, b) => b.length - a.length)[0];
        if (!clusters[key]) clusters[key] = { topic: key, count: 0, samples: [] };
        clusters[key].count++;
        if (clusters[key].samples.length < 3) clusters[key].samples.push(q);
    });
    return Object.values(clusters).sort((a, b) => b.count - a.count);
}

async function handleAdvancedAnalytics(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { businessId, period } = req.body || {};
    if (!businessId) return res.status(400).json({ success: false, message: 'Missing businessId.' });

    try {
        const db = getDb();
        const startISO = getPeriodStart(period || 'week').toISOString();

        const chatsSnap = await db.collection('user_bots').doc(businessId).collection('chats')
            .where('createdAt', '>=', startISO)
            .orderBy('createdAt', 'asc')
            .get();

        const chats = [];
        chatsSnap.forEach(d => chats.push({ id: d.id, ...d.data() }));

        if (!chats.length) {
            return res.json({
                success: true, period: period || 'week', totalMessages: 0, totalConversations: 0,
                fallback: { rate: 0, count: 0, total: 0 },
                sentiment: { buckets: [], overallAvg: 0, positive: 0, neutral: 0, negative: 0 },
                dropOff: { points: [], totalConversations: 0 },
                topics: { clusters: [] },
            });
        }

        // ── Fallback rate ──
        const fallbackCount = chats.filter(c => c.fallback === true || (c.fallback === undefined && detectFallback(c.answer))).length;
        const fallbackRate = Math.round((fallbackCount / chats.length) * 1000) / 10;

        // ── Sentiment (day-bucketed trend) ──
        const bucketMap = {};
        let posCount = 0, negCount = 0, neuCount = 0, sentSum = 0;
        chats.forEach(c => {
            const day = String(c.createdAt || '').slice(0, 10) || 'unknown';
            if (!bucketMap[day]) bucketMap[day] = { day, sum: 0, count: 0 };
            const s = typeof c.sentimentScore === 'number' ? c.sentimentScore : computeSentiment(c.question).score;
            bucketMap[day].sum += s;
            bucketMap[day].count++;
            sentSum += s;
            const label = c.sentimentLabel || computeSentiment(c.question).label;
            if (label === 'positive') posCount++;
            else if (label === 'negative') negCount++;
            else neuCount++;
        });
        const sentimentBuckets = Object.values(bucketMap)
            .sort((a, b) => a.day.localeCompare(b.day))
            .map(b => ({ day: b.day, avgSentiment: Math.round((b.sum / b.count) * 100) / 100, count: b.count }));

        // ── Drop-off funnel: last message of each conversation ──
        const convMap = {};
        chats.forEach(c => {
            if (!convMap[c.conversationId]) convMap[c.conversationId] = [];
            convMap[c.conversationId].push(c);
        });
        const dropOffMessages = Object.values(convMap)
            .map(msgs => msgs[msgs.length - 1]?.question)
            .filter(Boolean);
        const dropOffClusters = clusterByKeyword(dropOffMessages);

        // ── Topic clustering across all questions in period ──
        const allQuestions = chats.map(c => c.question).filter(Boolean);
        const topicClusters = clusterByKeyword(allQuestions);

        return res.json({
            success: true, period: period || 'week',
            totalMessages: chats.length, totalConversations: Object.keys(convMap).length,
            fallback: { rate: fallbackRate, count: fallbackCount, total: chats.length },
            sentiment: {
                buckets: sentimentBuckets,
                overallAvg: Math.round((sentSum / chats.length) * 100) / 100,
                positive: posCount, neutral: neuCount, negative: negCount,
            },
            dropOff: { points: dropOffClusters.slice(0, 8), totalConversations: Object.keys(convMap).length },
            topics: { clusters: topicClusters.slice(0, 10) },
        });
    } catch (err) {
        console.error('[AdvancedAnalytics]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
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

// ════════════════════════════════════════════════════════════════════════════
// LIVE DATABASE QUERYING (Firebase Project / Supabase)
// ════════════════════════════════════════════════════════════════════════════
const DB_SOURCE_CACHE_TTL_MS = 5 * 60 * 1000;
const DB_SOURCE_FETCH_TIMEOUT_MS = 7000;
const DB_SOURCE_MAX_COLLECTIONS = 6;
const DB_SOURCE_MAX_DOCS_PER_COLLECTION = 8;
const DB_SOURCE_MAX_TABLES = 6;
const DB_SOURCE_MAX_ROWS_PER_TABLE = 8;

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out')), ms)),
    ]);
}

function firestoreValueToPlain(v) {
    if (v == null) return null;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return v.doubleValue;
    if ('booleanValue' in v) return v.booleanValue;
    if ('timestampValue' in v) return v.timestampValue;
    if ('nullValue' in v) return null;
    if ('mapValue' in v) {
        const out = {};
        const fields = v.mapValue.fields || {};
        for (const k of Object.keys(fields)) out[k] = firestoreValueToPlain(fields[k]);
        return out;
    }
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(firestoreValueToPlain);
    if ('geoPointValue' in v) return v.geoPointValue;
    if ('referenceValue' in v) return v.referenceValue;
    return null;
}

function firestoreDocToPlain(doc) {
    const fields = doc.fields || {};
    const out = {};
    for (const k of Object.keys(fields)) out[k] = firestoreValueToPlain(fields[k]);
    return out;
}

async function fetchFirebaseProjectSnapshot(ownerEmail, db, projectId) {
    const userSnap = await db.collection('users').doc(ownerEmail).get();
    const fb = userSnap.data()?.integrations?.firebase_project;
    if (!fb?.connected) throw new Error('Firebase Project not connected.');
    const accessToken = await refreshGenericGoogleToken(fb, ownerEmail, db, 'firebase_project');

    const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;

    const listRes = await withTimeout(fetch(`${base}:listCollectionIds`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageSize: DB_SOURCE_MAX_COLLECTIONS }),
    }), DB_SOURCE_FETCH_TIMEOUT_MS);

    if (!listRes.ok) {
        const errText = await listRes.text();
        throw new Error(`Firestore list collections failed (HTTP ${listRes.status}): ${errText.substring(0, 300)}`);
    }
    const listData = await listRes.json();
    const collectionIds = (listData.collectionIds || []).slice(0, DB_SOURCE_MAX_COLLECTIONS);
    if (!collectionIds.length) return 'No readable top-level collections found in this Firestore project.';

    const sections = [];
    for (const colId of collectionIds) {
        try {
            const docsRes = await withTimeout(fetch(
                `${base}/${encodeURIComponent(colId)}?pageSize=${DB_SOURCE_MAX_DOCS_PER_COLLECTION}`,
                { headers: { Authorization: `Bearer ${accessToken}` } }
            ), DB_SOURCE_FETCH_TIMEOUT_MS);
            if (!docsRes.ok) continue;
            const docsData = await docsRes.json();
            const docs = (docsData.documents || []).map(d => ({
                id: (d.name || '').split('/').pop(),
                ...firestoreDocToPlain(d),
            }));
            if (docs.length) {
                sections.push(`Collection "${colId}" (up to ${DB_SOURCE_MAX_DOCS_PER_COLLECTION} docs):\n` +
                    docs.map(d => JSON.stringify(d)).join('\n'));
            }
        } catch (e) { /* skip this collection */ }
    }
    return sections.length ? sections.join('\n\n') : 'Collections exist, but no readable documents were found.';
}

async function refreshSupabaseToken(sb, ownerEmail, db) {
    let accessToken = sb.access_token;
    if (sb.refresh_token && sb.expiry_date) {
        const expiryMs = new Date(sb.expiry_date).getTime();
        if (!isNaN(expiryMs) && expiryMs < Date.now() + 60000) {
            const r = await fetch('https://api.supabase.com/v1/oauth/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + Buffer.from(`${process.env.SUPABASE_CLIENT_ID}:${process.env.SUPABASE_CLIENT_SECRET}`).toString('base64'),
                },
                body: new URLSearchParams({ refresh_token: sb.refresh_token, grant_type: 'refresh_token' }),
            });
            const t = await r.json();
            if (t.access_token) {
                accessToken = t.access_token;
                await db.collection('users').doc(ownerEmail).update({
                    'integrations.supabase.access_token': t.access_token,
                    'integrations.supabase.refresh_token': t.refresh_token || sb.refresh_token,
                    'integrations.supabase.expiry_date': new Date(Date.now() + (t.expires_in || 3500) * 1000).toISOString(),
                });
            }
        }
    }
    return accessToken;
}

async function runSupabaseSql(accessToken, projectRef, query) {
    const r = await withTimeout(fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
    }), DB_SOURCE_FETCH_TIMEOUT_MS);
    if (!r.ok) {
        const errText = await r.text();
        throw new Error(`Supabase query failed (HTTP ${r.status}): ${errText.substring(0, 300)}`);
    }
    return r.json();
}

async function fetchSupabaseProjectSnapshot(ownerEmail, db, projectRef) {
    const userSnap = await db.collection('users').doc(ownerEmail).get();
    const sb = userSnap.data()?.integrations?.supabase;
    if (!sb?.connected) throw new Error('Supabase not connected.');
    const accessToken = await refreshSupabaseToken(sb, ownerEmail, db);

    const tablesData = await runSupabaseSql(accessToken, projectRef,
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name LIMIT ${DB_SOURCE_MAX_TABLES};`);
    const tables = (Array.isArray(tablesData) ? tablesData : []).map(r => r.table_name).filter(Boolean);
    if (!tables.length) return 'No readable tables found in the public schema of this Supabase project.';

    const sections = [];
    for (const table of tables) {
        try {
            const rows = await runSupabaseSql(accessToken, projectRef, `SELECT * FROM "${table}" LIMIT ${DB_SOURCE_MAX_ROWS_PER_TABLE};`);
            sections.push(Array.isArray(rows) && rows.length
                ? `Table "${table}" (up to ${DB_SOURCE_MAX_ROWS_PER_TABLE} rows):\n${rows.map(r => JSON.stringify(r)).join('\n')}`
                : `Table "${table}": (empty or no readable rows)`);
        } catch (e) { /* skip this table */ }
    }
    return sections.join('\n\n');
}

// Cached on the bot doc so every chat message doesn't re-hit the live backend.
async function getDbSourceSnapshot(db, businessId, source, ownerEmail) {
    const cacheKey = `${source.service}:${source.projectId}`;
    const botRef = db.collection('user_bots').doc(businessId);
    const botSnap = await botRef.get();
    const cache = botSnap.data()?.dbSourcesCache || {};
    const cached = cache[cacheKey];

    if (cached?.fetchedAt && (Date.now() - new Date(cached.fetchedAt).getTime() < DB_SOURCE_CACHE_TTL_MS)) {
        return cached.text;
    }

    let text;
    try {
        if (source.service === 'firebase') text = await fetchFirebaseProjectSnapshot(ownerEmail, db, source.projectId);
        else if (source.service === 'supabase') text = await fetchSupabaseProjectSnapshot(ownerEmail, db, source.projectId);
        else return null;
    } catch (err) {
        console.error(`[DbSource:${cacheKey}]`, err.message);
        if (cached?.text) return cached.text; // serve stale data over nothing
        return `(Could not read live data from this ${source.service} project right now: ${err.message})`;
    }

    try {
        await botRef.set({ dbSourcesCache: { ...cache, [cacheKey]: { text, fetchedAt: new Date().toISOString() } } }, { merge: true });
    } catch (e) { /* best-effort */ }

    return text;
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

async function notifyOwnerAndEmployees(db, ownerEmail, notification) {
    if (!ownerEmail) return;
    const targets = [ownerEmail];
    try {
        const ownerSnap = await db.collection('users').doc(ownerEmail).get();
        const companyUsername = ownerSnap.exists ? ownerSnap.data()?.companyUsername : null;
        if (companyUsername) {
            const empSnap = await db.collection('users')
                .where('employeeOf', '==', companyUsername)
                .where('employeeStatus', '==', 'active')
                .get();
            empSnap.forEach(d => targets.push(d.id));
        }
    } catch (e) { console.warn('[NotifyOwnerAndEmployees]', e.message); }

    await Promise.all(targets.map(email => sendFCMToUser(email, notification).catch(() => {})));
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

function buildHumanRequestNotification(botName, lastMessage) {
    return {
        title: '🙋 Human Requested',
        body:  `A visitor chatting with "${botName}" asked to speak with a person: "${String(lastMessage || '').substring(0, 100)}"`,
        url:   '/?view=human',
        tag:   'comex-human-request',
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

        await deleteCalendarEventsForAppt(db, ownerEmail || appt.owner, appt);

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

        if ((field === 'appointmentDay' || field === 'appointmentTime') && (appt.googleCalendarEvents?.length || appt.googleCalendarEventId)) {
            const notifyEmail = ownerEmail || appt.owner;
            if (notifyEmail) {
                const updatedAppt = { ...appt, [field]: resolvedValue };
                if (field === 'appointmentDay') updatedAppt.scheduledDate = resolveDay(resolvedValue);
                await updateCalendarEventsForAppt(db, notifyEmail, updatedAppt);
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
        botData.displayName = botData.displayName || botData.name;
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
            name:            b.displayName || b.name    || 'AI Assistant',
            internalName:    b.name                     || null,
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
                allowHumanHandoff:    true,
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
// CHAT — with CANCEL / EDIT / multi-model / multi-agent / autonomous actions support
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
        let subAgents  = [];
        let agentActionsList = [];
        let behaviorConfig = {
            allowOutOfTopic: true,
            allowWebSearch: true,
            allowHallucination: false,
            allowAppointmentBooking: false,
            allowHumanHandoff: true,
        };

        if (botSnap.exists) {
            const b  = botSnap.data();
            ownerEmail = b.owner    || '';
            botName    = b.displayName || b.name || 'Assistant';
            modelKey   = b.modelKey || DEFAULT_MODEL_KEY;
            subAgents  = Array.isArray(b.subAgents) ? b.subAgents.filter(a => a?.id && a?.systemPrompt) : [];
            agentActionsList = Array.isArray(b.agentActions) ? b.agentActions.filter(a => a?.name && a?.url) : [];
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
            const dbSources = kc.databaseSources || [];
            if (dbSources.length) {
                const limitedSources = dbSources.slice(0, 3); // cap latency/cost
                const snapshots = await Promise.all(limitedSources.map(async s => {
                    try {
                        return { s, text: await getDbSourceSnapshot(db, businessId, s, ownerEmail) };
                    } catch (e) {
                        return { s, text: `(Error reading live data: ${e.message})` };
                    }
                }));
                const list = snapshots
                    .map(({ s, text }) => `--- ${s.service.toUpperCase()} project "${s.projectName || s.projectId}" ---\n${text}`)
                    .join('\n\n');
                sysPrompt += `\n\n[CONNECTED DATABASES — LIVE DATA SNAPSHOT]:\nBelow is a read-only, cached-up-to-5-min sample of data from the databases linked to this agent (limited number of collections/tables and rows). Use it to answer questions accurately. If something isn't shown in the sample, say you don't have visibility into it instead of guessing.\n\n${list}`;
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

        const humanHandoffEnabled = behaviorConfig.allowHumanHandoff !== false;
        sysPrompt += humanHandoffEnabled
            ? `\n\n- If the user asks to speak with a human/person/agent, that request will be routed automatically by the system — you don't need to say anything special about it yourself.`
            : `\n\n- Human agent handoff is DISABLED for this agent. If the user asks to speak with a human, a real person, or a live agent, politely explain that live handoff isn't available here right now, and offer to keep helping them yourself.`;

        // ── Autonomous actions — tell the model these tools exist and when to use them ──
        if (agentActionsList.length) {
            sysPrompt += `\n\nAUTONOMOUS ACTIONS:\n- You have access to real, live tools/actions that call external systems on this business's behalf (e.g. checking an order status, updating a record, triggering a webhook).\n- Call the matching tool whenever the user's request matches what that tool does, using the AI Description of each tool to decide when it applies.\n- Extract every required parameter directly from the conversation. If a required parameter is missing, ask the user for it before calling the tool.\n- After a tool result comes back, use it to give a clear, natural-language answer — never show the user raw JSON.\n- If a tool call fails or times out, apologize briefly and let the user know the action could not be completed right now.`;
        }

        // ── HUMAN HANDOFF — checked before anything else (only when enabled).
        const wantsHuman = humanHandoffEnabled && /speak to human support|connect (me )?(to )?(a )?human|talk to (a )?(human|person|someone|agent|representative)|(human|real) (agent|person)|customer service rep|talk to (someone|somebody) real/i.test(userMsg);
        if (wantsHuman) {
            try {
                const { requestId } = await ensureHumanRequest(db, {
                    businessId, botName, ownerEmail, conversationId: convId, lastMessage: userMsg,
                });
                await notifyOwnerAndEmployees(db, ownerEmail, buildHumanRequestNotification(botName, userMsg))
                    .catch(e => console.error('[Human/FCM]', e.message));
                const reply = "I've let our team know you'd like to speak with a person — someone will join this chat shortly. Feel free to keep typing in the meantime and they'll see it as soon as they connect.";
                await logChat(db, businessId, convId, userMsg, reply, false, false, { humanRequested: true });
                return res.json({ success: true, answer: reply, reply, _humanRequested: true, _requestId: requestId });
            } catch (e) {
                console.error('[HumanHandoff]', e.message);
            }
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

                if (ownerEmail) {
                    await deleteCalendarEventsForAppt(db, ownerEmail, appt);
                    await sendFCMToUser(ownerEmail, buildCancellationNotification(appt)).catch(e => console.error('[Cancel/FCM]', e.message));
                }

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

        // ── MULTI-AGENT ROUTING — classify + hand off to a specialized sub-agent, if any are configured ──
        let routedAgent = null;
        if (subAgents.length) {
            routedAgent = await routeToSubAgent(modelKey, userMsg, subAgents);
            if (routedAgent) {
                sysPrompt += `\n\n[ACTIVE SPECIALIZED AGENT: ${routedAgent.name}]\nYou are now acting as this specialized agent. Follow its instructions closely while still respecting the behavior settings above.\n${routedAgent.systemPrompt}`;
            }
        }

        // ── Build tool definitions for any configured autonomous actions ──
        const agentActionToolDefs = buildAgentActionToolDefs(agentActionsList);

        const baseMessages = [
            { role: 'system', content: sysPrompt },
            ...safeHistory,
            { role: 'user', content: userMsg },
        ];

        const choice = await callLLM({
            modelKey,
            messages: baseMessages,
            allFieldsPresent,
            enableBookingTool: bookingEnabled,
            extraTools: agentActionToolDefs,
        });
        if (choice?.content) choice.content = stripThinkingTags(choice.content);

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

            let bookingAccounts = [];
            if (ownerEmail) {
                bookingAccounts = bookingEnabledAccounts(await getGoogleCalendarAccounts(db, ownerEmail));
                if (bookingAccounts.length) {
                    const avail = await checkCalendarAvailability(bookingAccounts[0], dateISO, appointmentTime, ownerEmail, db);
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
                googleCalendarEvents: [],
            };

            const apptDocRef = await db.collection('appointments').add(appt);
            await db.collection('user_bots').doc(businessId).collection('appointments').add({ ...appt, globalId: apptDocRef.id });

            if (ownerEmail) {
                const createdEvents = [];
                for (const acct of bookingAccounts) {
                    try {
                        const calResult = await addCalendarEvent(acct, appt, ownerEmail, db);
                        if (calResult?.eventId) createdEvents.push({ accountEmail: acct.email, eventId: calResult.eventId });
                    } catch (e) { console.error('[Chat/Calendar]', acct.email, e.message); }
                }
                if (createdEvents.length) await apptDocRef.update({ googleCalendarEvents: createdEvents });

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

        // ── AUTONOMOUS ACTIONS — execute any non-booking tool calls the model requested ──
        if (agentActionToolDefs.length && Array.isArray(choice?.tool_calls) && choice.tool_calls.length) {
            const nonBookingCalls = choice.tool_calls.filter(tc => tc.function?.name !== 'appointmentBooking');

            if (nonBookingCalls.length) {
                const executed = await runAgentActionToolCalls(nonBookingCalls, agentActionsList);

                const assistantToolCallMsg = {
                    role: 'assistant',
                    content: choice.content || null,
                    tool_calls: nonBookingCalls,
                };

                const toolResultMessages = executed.map(e => ({
                    role: 'tool',
                    tool_call_id: e.toolCallId,
                    name: e.functionName,
                    content: JSON.stringify(e.result),
                }));

                const followUpMessages = [
                    ...baseMessages,
                    assistantToolCallMsg,
                    ...toolResultMessages,
                ];

                let followUpChoice;
                try {
                    followUpChoice = await callLLM({
                        modelKey,
                        messages: followUpMessages,
                        enableBookingTool: bookingEnabled,
                        extraTools: agentActionToolDefs,
                        toolChoice: 'none',
                    });
                    if (followUpChoice?.content) followUpChoice.content = stripThinkingTags(followUpChoice.content);
                } catch (err) {
                    console.error('[AgentActions/FollowUp]', err.message);
                    const fallbackAnswer = "I ran that action, but had trouble putting together a response. Could you ask again?";
                    await logChat(db, businessId, convId, userMsg, fallbackAnswer, true, false, { fallback: true });
                    return res.json({ success: true, answer: fallbackAnswer, reply: fallbackAnswer, _actionsExecuted: executed.map(e => e.functionName) });
                }

                const finalAnswer = followUpChoice?.content?.trim() ||
                    (executed.every(e => e.result?.success)
                        ? "Done — that action completed successfully."
                        : "I wasn't able to complete that action. Please try again or contact support.");

                await logChat(db, businessId, convId, userMsg, finalAnswer, true, false);
                return res.json({
                    success: true,
                    answer: finalAnswer,
                    reply: finalAnswer,
                    _agent: routedAgent?.name || null,
                    _actionsExecuted: executed.map(e => e.functionName),
                });
            }
        }

        const answer = choice?.content?.trim() || 'How can I help you?';
        await logChat(db, businessId, convId, userMsg, answer, true, false);
        return res.json({ success: true, answer, reply: answer, _agent: routedAgent?.name || null });

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
// PROMO CODES — dev-phase plan unlocks
// ════════════════════════════════════════════════════════════════════════════
async function handlePromoValidate(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { code, email } = req.body || {};
    if (!code || !email)
        return res.status(400).json({ success: false, message: 'Missing code or email.' });

    const normalizedCode = String(code).trim().toUpperCase();
    if (!normalizedCode)
        return res.status(400).json({ success: false, message: 'Please enter a promo code.' });

    try {
        const db = getDb();
        const promoRef = db.collection('promo_codes').doc(normalizedCode);

        const result = await db.runTransaction(async (tx) => {
            const snap = await tx.get(promoRef);
            if (!snap.exists) {
                return { success: false, message: 'Invalid or expired promo code.' };
            }

            const promo = snap.data();

            if (promo.active === false) {
                return { success: false, message: 'This promo code is no longer active.' };
            }

            if (promo.expiresAt && new Date(promo.expiresAt).getTime() < Date.now()) {
                return { success: false, message: 'This promo code has expired.' };
            }

            if (!promo.planKey) {
                return { success: false, message: 'This promo code is misconfigured. Please contact support.' };
            }

            const redeemedBy = Array.isArray(promo.redeemedBy) ? promo.redeemedBy : [];
            const alreadyRedeemedByThisUser = redeemedBy.includes(email);

            if (!alreadyRedeemedByThisUser) {
                const maxRedemptions = typeof promo.maxRedemptions === 'number' ? promo.maxRedemptions : null;
                const redeemedCount  = typeof promo.redeemedCount === 'number' ? promo.redeemedCount : redeemedBy.length;

                if (maxRedemptions !== null && redeemedCount >= maxRedemptions) {
                    return { success: false, message: 'This promo code has reached its redemption limit.' };
                }

                tx.set(promoRef, {
                    redeemedCount: redeemedCount + 1,
                    redeemedBy: [...redeemedBy, email],
                    lastRedeemedAt: new Date().toISOString(),
                }, { merge: true });
            }

            return { success: true, planKey: promo.planKey };
        });

        if (!result.success) {
            const isGone = /expired|no longer active|reached its redemption limit/i.test(result.message || '');
            return res.status(isGone ? 410 : 404).json(result);
        }

        return res.json(result);
    } catch (err) {
        console.error('[Promo/Validate]', err.message);
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
            enabledForBooking: true,
            access_token:  tokens.access_token,
            refresh_token: tokens.refresh_token || null,
            expiry_date:   tokens.expires_in
                ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
                : new Date(Date.now() + 3600 * 1000).toISOString(),
            connectedAt: new Date().toISOString(),
        };

        const idx = existing.findIndex(a => a.email === calendarLabel);
        if (idx >= 0) existing[idx] = { ...newAccount, enabledForBooking: existing[idx].enabledForBooking !== false }; else existing.push(newAccount);

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
// POST /api/integrations/toggle-calendar-account  { userEmail, calendarId, enabled }
// Turns booking on/off for one connected Google account, without disconnecting it.
// ════════════════════════════════════════════════════════════════════════════
async function handleToggleCalendarAccount(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { userEmail, calendarId, enabled } = req.body || {};
    if (!userEmail || !calendarId)
        return res.status(400).json({ success: false, message: 'Missing userEmail or calendarId.' });

    try {
        const db = getDb();
        const userRef = db.collection('users').doc(userEmail);
        const snap = await userRef.get();
        const accounts = snap.exists ? (snap.data()?.integrations?.google_calendar_accounts || []) : [];
        const idx = accounts.findIndex(a => a.email === calendarId);
        if (idx === -1) return res.status(404).json({ success: false, message: 'Calendar account not found.' });

        accounts[idx] = { ...accounts[idx], enabledForBooking: enabled !== false };
        await userRef.set({ integrations: { google_calendar_accounts: accounts } }, { merge: true });

        return res.json({ success: true });
    } catch (err) {
        console.error('[ToggleCalendarAccount]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// FIREBASE PROJECT OAUTH (data source, NOT the calendar flow above)
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
    url.searchParams.set('scope', [
    'https://www.googleapis.com/auth/firebase.readonly',
    'https://www.googleapis.com/auth/datastore',
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
// FIGMA OAUTH (design source — standard authorization-code flow)
// ════════════════════════════════════════════════════════════════════════════
async function handleFigmaOAuth(req, res) {
    const { email, origin } = req.query;
    if (!email) return res.status(400).send('Missing email.');

    const clientId    = process.env.FIGMA_CLIENT_ID;
    const redirectUri = process.env.FIGMA_REDIRECT_URI || `https://${req.headers.host}/api/oauth/figma/callback`;
    if (!clientId) return res.status(500).send('Missing FIGMA_CLIENT_ID env var.');

    const state = Buffer.from(JSON.stringify({ email, origin: origin || null })).toString('base64');
    const url = new URL('https://www.figma.com/oauth');
    url.searchParams.set('client_id',     clientId);
    url.searchParams.set('redirect_uri',  redirectUri);
    url.searchParams.set('scope',         'file_content:read,file_metadata:read');
    url.searchParams.set('state',         state);
    url.searchParams.set('response_type', 'code');

    return res.redirect(302, url.toString());
}

async function handleFigmaCallback(req, res) {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`OAuth error: ${error}`);
    if (!code || !state) return res.status(400).send('Missing code or state.');

    let email = '', origin = null;
    try {
        const parsed = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
        email  = parsed.email;
        origin = parsed.origin;
    } catch { return res.status(400).send('Invalid state parameter.'); }

    const clientId     = process.env.FIGMA_CLIENT_ID;
    const clientSecret = process.env.FIGMA_CLIENT_SECRET;
    const redirectUri  = process.env.FIGMA_REDIRECT_URI || `https://${req.headers.host}/api/oauth/figma/callback`;
    if (!clientId || !clientSecret) return res.status(500).send('Missing Figma OAuth env vars.');

    try {
        const tokenRes = await fetch('https://api.figma.com/v1/oauth/token', {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body:    new URLSearchParams({
                client_id: clientId, client_secret: clientSecret,
                redirect_uri: redirectUri, code, grant_type: 'authorization_code',
            }),
        });
        if (!tokenRes.ok) {
            const errText = await tokenRes.text();
            return res.status(400).send(`Figma token exchange failed (HTTP ${tokenRes.status}): ${errText}`);
        }
        const tokens = await tokenRes.json();
        if (tokens.error) return res.status(400).send(`Token error: ${tokens.error_description || tokens.error}`);

        const db = getDb();
        await db.collection('users').doc(email).set({
            integrations: {
                figma: {
                    connected:     true,
                    access_token:  tokens.access_token,
                    refresh_token: tokens.refresh_token || null,
                    expiry_date:   tokens.expires_in
                        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
                        : null,
                    connectedAt: new Date().toISOString(),
                },
            },
        }, { merge: true });

        const appUrl = origin || process.env.APP_URL ||
                       `https://${req.headers.host.replace('comex-backend', 'cometchat-ai-platform').replace('.vercel.app', '.web.app')}`;
        return res.redirect(302, `${appUrl}?figma_connected=1`);
    } catch (err) {
        console.error('[OAuth/Figma]', err.message);
        return res.status(500).send(`Server error: ${err.message}`);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// CANVA OAUTH (design source — Connect API, REQUIRES PKCE)
// The code_verifier can't survive in memory across the redirect on a
// serverless function, so it's parked in a short-lived Firestore doc keyed
// by a random state id, then deleted once the callback consumes it.
// ════════════════════════════════════════════════════════════════════════════
function base64url(buffer) {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function handleCanvaOAuth(req, res) {
    const { email, origin } = req.query;
    if (!email) return res.status(400).send('Missing email.');

    const clientId    = process.env.CANVA_CLIENT_ID;
    const redirectUri = process.env.CANVA_REDIRECT_URI || `https://${req.headers.host}/api/oauth/canva/callback`;
    if (!clientId) return res.status(500).send('Missing CANVA_CLIENT_ID env var.');

    const codeVerifier  = base64url(crypto.randomBytes(64));
    const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
    const stateId        = base64url(crypto.randomBytes(16));

    const db = getDb();
    await db.collection('oauth_pkce').doc(stateId).set({
        email, origin: origin || null, codeVerifier, createdAt: new Date().toISOString(),
    });

    const url = new URL('https://www.canva.com/api/oauth/authorize');
    url.searchParams.set('client_id',             clientId);
    url.searchParams.set('redirect_uri',          redirectUri);
    url.searchParams.set('response_type',         'code');
    url.searchParams.set('code_challenge',        codeChallenge);
    url.searchParams.set('code_challenge_method', 's256');
    url.searchParams.set('scope',                 'design:content:read design:meta:read asset:read');
    url.searchParams.set('state',                 stateId);

    return res.redirect(302, url.toString());
}

async function handleCanvaCallback(req, res) {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`OAuth error: ${error}`);
    if (!code || !state) return res.status(400).send('Missing code or state.');

    const db = getDb();
    const pkceRef  = db.collection('oauth_pkce').doc(state);
    const pkceSnap = await pkceRef.get();
    if (!pkceSnap.exists) return res.status(400).send('Invalid or expired state parameter. Please try connecting again.');

    const { email, origin, codeVerifier } = pkceSnap.data();
    await pkceRef.delete().catch(() => {});

    const clientId     = process.env.CANVA_CLIENT_ID;
    const clientSecret = process.env.CANVA_CLIENT_SECRET;
    const redirectUri  = process.env.CANVA_REDIRECT_URI || `https://${req.headers.host}/api/oauth/canva/callback`;
    if (!clientId || !clientSecret) return res.status(500).send('Missing Canva OAuth env vars.');

    try {
        const tokenRes = await fetch('https://api.canva.com/rest/v1/oauth/token', {
            method:  'POST',
            headers: {
                'Content-Type':  'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code', code,
                code_verifier: codeVerifier, redirect_uri: redirectUri,
            }),
        });
        const tokens = await tokenRes.json();
        if (tokens.error) return res.status(400).send(`Token error: ${tokens.error_description || tokens.error}`);

        await db.collection('users').doc(email).set({
            integrations: {
                canva: {
                    connected:     true,
                    access_token:  tokens.access_token,
                    refresh_token: tokens.refresh_token || null,
                    expiry_date:   tokens.expires_in
                        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
                        : null,
                    connectedAt: new Date().toISOString(),
                },
            },
        }, { merge: true });

        const appUrl = origin || process.env.APP_URL ||
                       `https://${req.headers.host.replace('comex-backend', 'cometchat-ai-platform').replace('.vercel.app', '.web.app')}`;
        return res.redirect(302, `${appUrl}?canva_connected=1`);
    } catch (err) {
        console.error('[OAuth/Canva]', err.message);
        return res.status(500).send(`Server error: ${err.message}`);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// DESIGN IMPORT + VALIDATION (Canva / Figma)
// ════════════════════════════════════════════════════════════════════════════
function rgbToHex(r, g, b) {
    const toHex = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

const REQUIRED_DESIGN_ELEMENTS = [
    { key: 'header',  label: 'Header / Bot Name',         match: /header|bot[\s_-]?name|title/i },
    { key: 'avatar',  label: 'Avatar / Logo',             match: /avatar|logo|icon/i },
    { key: 'bubble',  label: 'Chat Bubble (theme color)', match: /bubble|chat[\s_-]?bg|background/i },
    { key: 'sendbtn', label: 'Send Button',               match: /send[\s_-]?button|send[\s_-]?btn/i },
];

async function handleDesignImport(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { ownerEmail, service, fileKeyOrDesignId } = req.body || {};
    if (!ownerEmail || !service || !fileKeyOrDesignId)
        return res.status(400).json({ success: false, message: 'Missing ownerEmail, service, or fileKeyOrDesignId.' });
    if (!['figma', 'canva'].includes(service))
        return res.status(400).json({ success: false, message: `Unknown service: ${service}` });

    try {
        const db = getDb();
        const userSnap = await db.collection('users').doc(ownerEmail).get();
        const integrations = userSnap.exists ? (userSnap.data()?.integrations || {}) : {};

        let layerNames = [];
        const extracted = { themeColor: null, logoUrl: null };

        if (service === 'figma') {
            const figma = integrations.figma;
            if (!figma?.connected) return res.status(400).json({ success: false, message: 'Figma not connected.' });

            const r = await fetch(`https://api.figma.com/v1/files/${encodeURIComponent(fileKeyOrDesignId)}`, {
                headers: { Authorization: `Bearer ${figma.access_token}` },
            });
            if (!r.ok) return res.status(502).json({ success: false, message: `Figma API error: ${await r.text()}` });
            const data = await r.json();

            const walk = (node) => {
                if (!node) return;
                const name = node.name || '';
                layerNames.push(name);
                if (/bubble|background/i.test(name) && node.fills?.[0]?.color) {
                    const c = node.fills[0].color;
                    extracted.themeColor = rgbToHex(c.r, c.g, c.b);
                }
                if (/avatar|logo/i.test(name) && node.type === 'IMAGE') {
                    extracted.logoUrl = 'figma-image-ref'; // to fully resolve: call POST /v1/images/:key with node id
                }
                (node.children || []).forEach(walk);
            };
            walk(data.document);
        }

        if (service === 'canva') {
            const canva = integrations.canva;
            if (!canva?.connected) return res.status(400).json({ success: false, message: 'Canva not connected.' });

            const r = await fetch(`https://api.canva.com/rest/v1/designs/${encodeURIComponent(fileKeyOrDesignId)}`, {
                headers: { Authorization: `Bearer ${canva.access_token}` },
            });
            if (!r.ok) return res.status(502).json({ success: false, message: `Canva API error: ${await r.text()}` });
            const data = await r.json();
            layerNames = [data.design?.title || ''];
        }

        const results = REQUIRED_DESIGN_ELEMENTS.map(req => ({
            key: req.key,
            label: req.label,
            found: layerNames.some(n => req.match.test(n)),
        }));
        const allFound = results.every(r => r.found);

        return res.json({ success: true, allFound, results, extracted });
    } catch (err) {
        console.error('[DesignImport]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/integrations/list-projects?service=firebase|supabase&ownerEmail=...
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

    const fieldMap = {
        firebase: 'firebase_project',
        supabase: 'supabase',
        canva:    'canva',
        figma:    'figma',
    };
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

function companyKeyFrom(raw) {
    return String(raw || '').trim().replace(/^@/, '').toLowerCase();
}

const JOIN_CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const JOIN_CODE_TTL_MS  = 36 * 60 * 60 * 1000;

function generateJoinCode() {
    let code = '';
    for (let i = 0; i < 8; i++) code += JOIN_CODE_CHARSET[Math.floor(Math.random() * JOIN_CODE_CHARSET.length)];
    return code;
}

async function requireCompanyOwner(db, companyUsername, requestedBy) {
    const key = companyKeyFrom(companyUsername);
    const secretSnap = await db.collection('company_secrets').doc(key).get();
    if (!secretSnap.exists) throw { status: 404, message: 'Company not found.' };
    const secret = secretSnap.data();
    if (secret.ownerEmail !== requestedBy) throw { status: 403, message: 'Only the company owner can do this.' };
    return { key, secret };
}

async function ensureValidJoinCode(db, key, secret) {
    const now = Date.now();
    const expiresAt = secret.joinCodeExpiresAt ? new Date(secret.joinCodeExpiresAt).getTime() : 0;
    if (secret.joinCode && expiresAt > now) {
        return { code: secret.joinCode, expiresAt: secret.joinCodeExpiresAt };
    }
    const code = generateJoinCode();
    const newExpiresAt = new Date(now + JOIN_CODE_TTL_MS).toISOString();
    await db.collection('company_secrets').doc(key).set({
        joinCode: code, joinCodeCreatedAt: new Date(now).toISOString(), joinCodeExpiresAt: newExpiresAt,
    }, { merge: true });
    return { code, expiresAt: newExpiresAt };
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/company/check-username?username=
// ════════════════════════════════════════════════════════════════════════════
async function handleCompanyCheckUsername(req, res) {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, message: 'Missing username.' });
    const key = companyKeyFrom(username);
    if (!/^[a-z0-9_]{3,30}$/.test(key))
        return res.json({ success: true, available: false, reason: '3-30 letters, numbers, or underscores only.' });
    try {
        const snap = await getDb().collection('companies').doc(key).get();
        return res.json({ success: true, available: !snap.exists });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/company/setup  { username, ownerEmail, logoBase64 }
// ════════════════════════════════════════════════════════════════════════════
async function handleCompanySetup(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { username, ownerEmail, logoBase64 } = req.body || {};
    if (!username || !ownerEmail)
        return res.status(400).json({ success: false, message: 'Missing username or ownerEmail.' });

    const key = companyKeyFrom(username);
    if (!/^[a-z0-9_]{3,30}$/.test(key))
        return res.status(400).json({ success: false, message: 'Username must be 3-30 letters, numbers, or underscores.' });

    try {
        const db = getDb();
        const companyRef = db.collection('companies').doc(key);
        const secretRef   = db.collection('company_secrets').doc(key);

        await db.runTransaction(async (tx) => {
            const snap = await tx.get(companyRef);
            if (snap.exists) throw new Error('That username was just taken — please pick another.');

            const now = Date.now();
            tx.set(companyRef, {
                displayUsername: '@' + username.replace(/^@/, ''),
                logoBase64: logoBase64 || null,
                createdAt: new Date(now).toISOString(),
            });
            tx.set(secretRef, {
                ownerEmail,
                joinCode: generateJoinCode(),
                joinCodeCreatedAt: new Date(now).toISOString(),
                joinCodeExpiresAt: new Date(now + JOIN_CODE_TTL_MS).toISOString(),
            });
        });

        await db.collection('users').doc(ownerEmail).set({
            accountType: 'company',
            companyUsername: key,
            logoBase64: logoBase64 || null,
            pendingSetup: false,
        }, { merge: true });

        return res.json({ success: true, key });
    } catch (err) {
        console.error('[Company/Setup]', err.message);
        return res.status(400).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/company/join-code?companyUsername=&requestedBy=
// ════════════════════════════════════════════════════════════════════════════
async function handleCompanyJoinCode(req, res) {
    const { companyUsername, requestedBy } = req.query;
    if (!companyUsername || !requestedBy)
        return res.status(400).json({ success: false, message: 'Missing companyUsername or requestedBy.' });
    try {
        const db = getDb();
        const { key, secret } = await requireCompanyOwner(db, companyUsername, requestedBy);
        const { code, expiresAt } = await ensureValidJoinCode(db, key, secret);
        return res.json({ success: true, joinCode: code, expiresAt });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ success: false, message: err.message });
        console.error('[Company/JoinCode]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/company/join-code/regenerate  { companyUsername, requestedBy }
// ════════════════════════════════════════════════════════════════════════════
async function handleCompanyJoinCodeRegenerate(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { companyUsername, requestedBy } = req.body || {};
    if (!companyUsername || !requestedBy)
        return res.status(400).json({ success: false, message: 'Missing companyUsername or requestedBy.' });
    try {
        const db = getDb();
        const { key } = await requireCompanyOwner(db, companyUsername, requestedBy);
        const now = Date.now();
        const code = generateJoinCode();
        const expiresAt = new Date(now + JOIN_CODE_TTL_MS).toISOString();
        await db.collection('company_secrets').doc(key).set({
            joinCode: code, joinCodeCreatedAt: new Date(now).toISOString(), joinCodeExpiresAt: expiresAt,
        }, { merge: true });
        return res.json({ success: true, joinCode: code, expiresAt });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ success: false, message: err.message });
        console.error('[Company/JoinCodeRegenerate]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/employee/verify-and-connect  { companyUsername, joinCode, employeeEmail, logoBase64? }
// ════════════════════════════════════════════════════════════════════════════
async function handleEmployeeVerifyAndConnect(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { companyUsername, joinCode, employeeEmail, logoBase64 } = req.body || {};
    if (!companyUsername || !joinCode || !employeeEmail)
        return res.status(400).json({ success: false, message: 'Missing companyUsername, joinCode, or employeeEmail.' });

    try {
        const db  = getDb();
        const key = companyKeyFrom(companyUsername);
        const [companySnap, secretSnap] = await Promise.all([
            db.collection('companies').doc(key).get(),
            db.collection('company_secrets').doc(key).get(),
        ]);
        if (!companySnap.exists || !secretSnap.exists)
            return res.status(404).json({ success: false, message: 'Company not found.' });

        const secret = secretSnap.data();
        const submitted = String(joinCode).trim().toUpperCase();
        const expiresAt = secret.joinCodeExpiresAt ? new Date(secret.joinCodeExpiresAt).getTime() : 0;

        if (!secret.joinCode || submitted !== secret.joinCode) {
            return res.status(401).json({ success: false, message: 'Incorrect join code.' });
        }
        if (expiresAt <= Date.now()) {
            return res.status(401).json({ success: false, message: 'This join code has expired. Ask the company owner for a fresh one.' });
        }

        const now = Date.now();
        await db.collection('company_secrets').doc(key).set({
            joinCode: generateJoinCode(),
            joinCodeCreatedAt: new Date(now).toISOString(),
            joinCodeExpiresAt: new Date(now + JOIN_CODE_TTL_MS).toISOString(),
        }, { merge: true });

        await db.collection('users').doc(employeeEmail).set({
            accountType:     'employee',
            employeeOf:      key,
            employeeStatus:  'active',
            pendingSetup:    false,
            connectedAt:     new Date().toISOString(),
            employerOwnerEmail: secret.ownerEmail,
            ...(logoBase64 ? { logoBase64 } : {}),
        }, { merge: true });

        return res.json({ success: true, companyDisplayUsername: companySnap.data().displayUsername || `@${key}` });
    } catch (err) {
        console.error('[Employee/VerifyConnect]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/company/employees/list?companyUsername=&requestedBy=
// ════════════════════════════════════════════════════════════════════════════
async function handleCompanyEmployeesList(req, res) {
    const { companyUsername, requestedBy } = req.query;
    if (!companyUsername || !requestedBy)
        return res.status(400).json({ success: false, message: 'Missing companyUsername or requestedBy.' });

    try {
        const db = getDb();
        const { key } = await requireCompanyOwner(db, companyUsername, requestedBy);

        const snap = await db.collection('users').where('employeeOf', '==', key).get();
        const employees = [];
        snap.forEach(d => {
            const u = d.data();
            employees.push({
                email:        d.id,
                status:       u.employeeStatus || 'active',
                connectedAt:  u.connectedAt || null,
            });
        });

        return res.json({ success: true, employees });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ success: false, message: err.message });
        console.error('[Company/EmployeesList]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/company/employees/remove  { companyUsername, employeeEmail, requestedBy }
// ════════════════════════════════════════════════════════════════════════════
async function handleCompanyEmployeeRemove(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { companyUsername, employeeEmail, requestedBy } = req.body || {};
    if (!companyUsername || !employeeEmail || !requestedBy)
        return res.status(400).json({ success: false, message: 'Missing required fields.' });

    try {
        const db = getDb();
        await requireCompanyOwner(db, companyUsername, requestedBy);

        await db.collection('users').doc(employeeEmail).set({
            employeeOf:     null,
            employeeStatus: 'removed',
        }, { merge: true });

        return res.json({ success: true, message: 'Employee removed from company.' });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ success: false, message: err.message });
        console.error('[Company/EmployeeRemove]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/company/employees/disable  { companyUsername, employeeEmail, requestedBy, disable }
// ════════════════════════════════════════════════════════════════════════════
async function handleCompanyEmployeeDisable(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { companyUsername, employeeEmail, requestedBy, disable } = req.body || {};
    if (!companyUsername || !employeeEmail || !requestedBy)
        return res.status(400).json({ success: false, message: 'Missing required fields.' });

    try {
        const db = getDb();
        await requireCompanyOwner(db, companyUsername, requestedBy);

        const isDisabling = disable !== false;
        try {
            const authAdmin  = getAuthAdmin();
            const userRecord = await authAdmin.getUserByEmail(employeeEmail);
            await authAdmin.updateUser(userRecord.uid, { disabled: isDisabling });
        } catch (e) {
            console.warn('[Company/EmployeeDisable] Auth admin update skipped:', e.message);
        }

        await db.collection('users').doc(employeeEmail).set({
            employeeStatus: isDisabling ? 'disabled' : 'active',
        }, { merge: true });

        return res.json({ success: true, message: isDisabling ? 'Employee account disabled.' : 'Employee account re-enabled.' });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ success: false, message: err.message });
        console.error('[Company/EmployeeDisable]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/company/employees/delete  { companyUsername, employeeEmail, requestedBy }
// ════════════════════════════════════════════════════════════════════════════
async function handleCompanyEmployeeDelete(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { companyUsername, employeeEmail, requestedBy } = req.body || {};
    if (!companyUsername || !employeeEmail || !requestedBy)
        return res.status(400).json({ success: false, message: 'Missing required fields.' });

    try {
        const db = getDb();
        await requireCompanyOwner(db, companyUsername, requestedBy);

        try {
            const authAdmin  = getAuthAdmin();
            const userRecord = await authAdmin.getUserByEmail(employeeEmail);
            await authAdmin.deleteUser(userRecord.uid);
        } catch (e) {
            console.warn('[Company/EmployeeDelete] Auth admin delete skipped:', e.message);
        }

        await db.collection('users').doc(employeeEmail).delete().catch(() => {});

        return res.json({ success: true, message: 'Employee account permanently deleted.' });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ success: false, message: err.message });
        console.error('[Company/EmployeeDelete]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// HUMAN HANDOFF
// ════════════════════════════════════════════════════════════════════════════

function humanRequestId(businessId, conversationId, suffix) {
    return suffix ? `${businessId}__${conversationId}__${suffix}` : `${businessId}__${conversationId}`;
}

async function ensureHumanRequest(db, { businessId, botName, ownerEmail, conversationId, lastMessage }) {
    const baseId = humanRequestId(businessId, conversationId);
    const ref = db.collection('human_requests').doc(baseId);
    const snap = await ref.get();
    const now = new Date().toISOString();

    if (!snap.exists) {
        await ref.set({
            businessId, botName, ownerEmail, conversationId,
            status: 'pending', agentEmail: null,
            lastMessage: lastMessage || '', createdAt: now, updatedAt: now,
        });
        return { requestId: baseId };
    }

    const existing = snap.data();

    if (existing.status === 'closed') {
        const newId  = humanRequestId(businessId, conversationId, Date.now());
        const newRef = db.collection('human_requests').doc(newId);
        await newRef.set({
            businessId, botName, ownerEmail, conversationId,
            status: 'pending', agentEmail: null,
            lastMessage: lastMessage || '', createdAt: now, updatedAt: now,
        });
        return { requestId: newId };
    }

    await ref.set({
        lastMessage: lastMessage || existing.lastMessage || '',
        updatedAt: now,
    }, { merge: true });
    return { requestId: baseId };
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/human/list?ownerEmail=
// ════════════════════════════════════════════════════════════════════════════
async function handleHumanList(req, res) {
    const { ownerEmail } = req.query;
    if (!ownerEmail) return res.status(400).json({ success: false, message: 'Missing ownerEmail.' });
    try {
        const db = getDb();
        const snap = await db.collection('human_requests')
            .where('ownerEmail', '==', ownerEmail)
            .where('status', 'in', ['pending', 'active'])
            .get();

        const requests = [];
        snap.forEach(d => requests.push({ id: d.id, ...d.data() }));

        const byBotOldestFirst = [...requests].sort(
            (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
        );
        const seenCount = {};
        byBotOldestFirst.forEach(r => {
            const key = r.businessId;
            const n = seenCount[key] || 0;
            const base = r.botName || r.businessId;
            r.displayLabel = n === 0 ? base : `${base}-${String(n).padStart(2, '0')}`;
            seenCount[key] = n + 1;
        });

        requests.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

        return res.json({ success: true, requests });
    } catch (err) {
        console.error('[Human/List]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/human/connect  { requestId, agentEmail }
// ════════════════════════════════════════════════════════════════════════════
async function handleHumanConnect(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { requestId, agentEmail } = req.body || {};
    if (!requestId || !agentEmail) return res.status(400).json({ success: false, message: 'Missing requestId or agentEmail.' });
    try {
        const db = getDb();
        const ref = db.collection('human_requests').doc(requestId);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ success: false, message: 'Request not found.' });

        const existing = snap.data();
        if (existing.status === 'active' && existing.agentEmail && existing.agentEmail !== agentEmail) {
            return res.status(409).json({ success: false, message: `Already being handled by ${existing.agentEmail}.` });
        }

        await ref.set({ status: 'active', agentEmail, updatedAt: new Date().toISOString() }, { merge: true });
        return res.json({ success: true });
    } catch (err) {
        console.error('[Human/Connect]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/human/send-message  { requestId, sender: 'user'|'agent', text, agentEmail? }
// ════════════════════════════════════════════════════════════════════════════
async function handleHumanSendMessage(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { requestId, sender, text, agentEmail } = req.body || {};
    if (!requestId || !sender || !text)
        return res.status(400).json({ success: false, message: 'Missing requestId, sender, or text.' });
    if (!['user', 'agent'].includes(sender))
        return res.status(400).json({ success: false, message: 'sender must be "user" or "agent".' });

    try {
        const db  = getDb();
        const ref = db.collection('human_requests').doc(requestId);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ success: false, message: 'Request not found.' });

        const now = new Date().toISOString();
        await ref.collection('messages').add({ sender, text: String(text), agentEmail: agentEmail || null, createdAt: now });

        const update = { lastMessage: text, updatedAt: now };
        await ref.set(update, { merge: true });

        return res.json({ success: true, wasClosed: snap.data().status === 'closed' });
    } catch (err) {
        console.error('[Human/SendMessage]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/human/poll?requestId=&sinceTs=
// ════════════════════════════════════════════════════════════════════════════
async function handleHumanPoll(req, res) {
    const { requestId, sinceTs } = req.query;
    if (!requestId) return res.status(400).json({ success: false, message: 'Missing requestId.' });
    try {
        const db  = getDb();
        const ref = db.collection('human_requests').doc(requestId);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ success: false, message: 'Request not found.' });

        let msgQuery = ref.collection('messages').orderBy('createdAt', 'asc').limit(200);
        if (sinceTs) msgQuery = ref.collection('messages').where('createdAt', '>', sinceTs).orderBy('createdAt', 'asc').limit(200);

        const msgSnap = await msgQuery.get();
        const messages = [];
        msgSnap.forEach(d => messages.push({ id: d.id, ...d.data() }));

        const data = snap.data();
        return res.json({ success: true, status: data.status, agentEmail: data.agentEmail || null, messages });
    } catch (err) {
        console.error('[Human/Poll]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/human/close  { requestId, agentEmail?, closedBy? }
// ════════════════════════════════════════════════════════════════════════════
async function handleHumanClose(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { requestId, agentEmail, closedBy } = req.body || {};
    if (!requestId) return res.status(400).json({ success: false, message: 'Missing requestId.' });
    try {
        const db  = getDb();
        const ref = db.collection('human_requests').doc(requestId);
        const now = new Date().toISOString();
        await ref.set({ status: 'closed', updatedAt: now }, { merge: true });

        const message = closedBy === 'user'
            ? 'The visitor ended this conversation.'
            : 'The conversation has been closed by our team. Feel free to keep chatting with the assistant.';

        await ref.collection('messages').add({
            sender: 'agent', text: message,
            agentEmail: agentEmail || null, createdAt: now, isSystem: true,
        });
        return res.json({ success: true });
    } catch (err) {
        console.error('[Human/Close]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/account/update-photo  { email, logoBase64 }
// ════════════════════════════════════════════════════════════════════════════
async function handleUpdateProfilePhoto(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { email, logoBase64 } = req.body || {};
    if (!email || !logoBase64) return res.status(400).json({ success: false, message: 'Missing email or logoBase64.' });

    try {
        const db = getDb();
        await db.collection('users').doc(email).set({ logoBase64 }, { merge: true });

        const userSnap = await db.collection('users').doc(email).get();
        const companyUsername = userSnap.data()?.companyUsername;
        if (companyUsername) {
            await db.collection('companies').doc(companyUsername).set({ logoBase64 }, { merge: true });
        }

        return res.json({ success: true });
    } catch (err) {
        console.error('[Account/UpdatePhoto]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

async function logChat(db, businessId, convId, question, answer, isGenuineQuery, isLeadCaptured, opts = {}) {
    try {
        const sentiment = computeSentiment(question);
        const fallback = opts.fallback !== undefined ? opts.fallback : detectFallback(answer);
        await db.collection('user_bots').doc(businessId).collection('chats').add({
            conversationId: convId, question, answer, isGenuineQuery, isLeadCaptured,
            fallback: !!fallback,
            humanRequested: !!opts.humanRequested,
            sentimentLabel: sentiment.label,
            sentimentScore: sentiment.score,
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

// ════════════════════════════════════════════════════════════════════════════
// POST /api/account/check-exists  { email }
// Note: this intentionally reveals whether an email is registered, which is
// a mild email-enumeration tradeoff — acceptable here since it's explicitly
// part of the requested UX. Consider rate-limiting this endpoint.
// ════════════════════════════════════════════════════════════════════════════
async function handleCheckAccountExists(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ success: false, message: 'Missing email.' });

    try {
        const authAdmin = getAuthAdmin();
        await authAdmin.getUserByEmail(email);
        return res.json({ success: true, exists: true });
    } catch (err) {
        if (err.code === 'auth/user-not-found') {
            return res.json({ success: true, exists: false });
        }
        console.error('[Account/CheckExists]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

async function handleAccountChangeEmail(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { oldEmail, newEmail } = req.body || {};
    if (!oldEmail || !newEmail) return res.status(400).json({ success: false, message: 'Missing oldEmail or newEmail.' });

    try {
        const db = getDb();
        const oldSnap = await db.collection('users').doc(oldEmail).get();
        const profile = oldSnap.exists ? oldSnap.data() : {};
        await db.collection('users').doc(newEmail).set(profile, { merge: true });
        await db.collection('users').doc(oldEmail).delete().catch(() => {});

        const ownerCollections = ['user_bots', 'appointments', 'reports', 'leads'];
        for (const col of ownerCollections) {
            const snap = await db.collection(col).where('owner', '==', oldEmail).get();
            if (snap.empty) continue;
            const batch = db.batch();
            snap.docs.forEach(d => batch.update(d.ref, { owner: newEmail }));
            await batch.commit();
        }

        const empSnap = await db.collection('users').where('employerOwnerEmail', '==', oldEmail).get();
        if (!empSnap.empty) {
            const batch = db.batch();
            empSnap.docs.forEach(d => batch.update(d.ref, { employerOwnerEmail: newEmail }));
            await batch.commit();
        }

        const secretsSnap = await db.collection('company_secrets').where('ownerEmail', '==', oldEmail).get();
        if (!secretsSnap.empty) {
            const batch = db.batch();
            secretsSnap.docs.forEach(d => batch.update(d.ref, { ownerEmail: newEmail }));
            await batch.commit();
        }

        return res.json({ success: true });
    } catch (err) {
        console.error('[Account/ChangeEmail]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// PASSWORD RESET — fully custom, bypasses Firebase's oobCode/hosted page
// entirely so the whole flow (and auto-login afterward) stays on our domain.
// ════════════════════════════════════════════════════════════════════════════
const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function getResend() {
    if (!process.env.RESEND_API_KEY) throw new Error('Missing RESEND_API_KEY env var.');
    return new Resend(process.env.RESEND_API_KEY);
}

// POST /api/password-reset/request  { email, origin }
async function handlePasswordResetRequest(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { email, origin } = req.body || {};
    if (!email) return res.status(400).json({ success: false, message: 'Missing email.' });

    try {
        const db = getDb();
        const authAdmin = getAuthAdmin();

        let userRecord;
        try {
            userRecord = await authAdmin.getUserByEmail(email);
        } catch (e) {
            if (e.code === 'auth/user-not-found') {
                return res.status(404).json({ success: false, message: 'No account found with that email address.' });
            }
            throw e;
        }

        const token = crypto.randomBytes(32).toString('hex');
        const now = Date.now();
        await db.collection('password_reset_tokens').doc(token).set({
            email, uid: userRecord.uid,
            createdAt: new Date(now).toISOString(),
            expiresAt: new Date(now + PASSWORD_RESET_TOKEN_TTL_MS).toISOString(),
            used: false,
        });

        const appUrl = origin || process.env.APP_URL || `https://${req.headers.host}`;
        const resetLink = `${appUrl}/reset-password?token=${token}`;

        const resend = getResend();
        await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'Comex AI <onboarding@resend.dev>',
            to: email,
            subject: 'Reset your Comex AI password',
            html: `
                <div style="max-width: 520px; margin: 0 auto; font-family: 'Google Sans Flex', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 20px; padding: 40px 36px; box-shadow: 0 10px 25px -5px rgba(15, 23, 42, 0.05); box-sizing: border-box;">

  <!-- Comex AI Brand Header -->
  <div style="display: flex; align-items: center; margin-bottom: 28px;">
    <span style="margin-left: 12px; font-size: 22px; font-weight: 800; color: #0f172a; letter-spacing: -0.5px;">
      Comex<span style="color: #5b3df5;"> AI</span>
    </span>
  </div>

  <!-- Title & Description -->
  <h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 700; color: #0f172a; letter-spacing: -0.3px; line-height: 1.3;">
    Reset your password
  </h2>
  
  <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.6; color: #475569;">
    We received a request to reset the password for your Comex AI account attached to 
    <span style="display: inline-block; background-color: #f1f5f9; color: #334155; padding: 2px 10px; border-radius: 6px; font-weight: 600; font-size: 14px; word-break: break-all;">
      ${email}
    </span>.
  </p>

  <!-- Action Button -->
  <div style="text-align: center; margin-bottom: 28px;">
    <a href="${resetLink}" target="_blank" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #5b3df5 0%, #7c3aed 100%); color: #ffffff; text-decoration: none; font-weight: 700; font-size: 15px; border-radius: 100px; box-shadow: 0 6px 20px rgba(91, 61, 245, 0.35); letter-spacing: 0.2px;">
      Reset Password &rarr;
    </a>
  </div>

  <!-- Security Notice -->
  <div style="background-color: #f8fafc; border-left: 4px solid #5b3df5; border-radius: 8px; padding: 14px 16px; margin-bottom: 24px;">
    <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #64748b;">
      <strong style="color: #0f172a; font-weight: 600;">Security Note:</strong> This reset link will expire in <strong style="color: #5b3df5;">1 hour</strong>. If you did not request a password reset, no action is required and you can safely ignore this email.
    </p>
  </div>

  <!-- Fallback Link Area -->
  <div style="border-top: 1px solid #f1f5f9; padding-top: 20px;">
    <p style="margin: 0 0 8px 0; font-size: 12px; color: #94a3b8; line-height: 1.4;">
      Having trouble with the button? Copy and paste this link into your web browser:
    </p>
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; word-break: break-all;">
      <a href="${resetLink}" style="font-size: 12px; color: #5b3df5; text-decoration: underline; line-height: 1.4;">
        ${resetLink}
      </a>
    </div>
  </div>

</div>`,
        });

        return res.json({ success: true, message: 'Reset email sent.' });
    } catch (err) {
        console.error('[PasswordReset/Request]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// GET /api/password-reset/verify?token=...
async function handlePasswordResetVerify(req, res) {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, message: 'Missing token.' });

    try {
        const db = getDb();
        const snap = await db.collection('password_reset_tokens').doc(token).get();
        if (!snap.exists) return res.json({ success: true, valid: false, message: 'This reset link is invalid.' });

        const data = snap.data();
        if (data.used) return res.json({ success: true, valid: false, message: 'This reset link has already been used.' });
        if (new Date(data.expiresAt).getTime() < Date.now()) {
            return res.json({ success: true, valid: false, message: 'This reset link has expired. Please request a new one.' });
        }

        return res.json({ success: true, valid: true, email: data.email });
    } catch (err) {
        console.error('[PasswordReset/Verify]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// POST /api/password-reset/confirm  { token, newPassword }
async function handlePasswordResetConfirm(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return res.status(400).json({ success: false, message: 'Missing token or newPassword.' });
    if (newPassword.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });

    try {
        const db = getDb();
        const tokenRef = db.collection('password_reset_tokens').doc(token);

        // Transaction guards against the same token being redeemed twice
        // (e.g. a double-click or the request firing twice in flight).
        const result = await db.runTransaction(async (tx) => {
            const snap = await tx.get(tokenRef);
            if (!snap.exists) return { success: false, message: 'This reset link is invalid.' };
            const data = snap.data();
            if (data.used) return { success: false, message: 'This reset link has already been used.' };
            if (new Date(data.expiresAt).getTime() < Date.now()) {
                return { success: false, message: 'This reset link has expired. Please request a new one.' };
            }
            tx.update(tokenRef, { used: true, usedAt: new Date().toISOString() });
            return { success: true, uid: data.uid, email: data.email };
        });

        if (!result.success) return res.status(400).json(result);

        const authAdmin = getAuthAdmin();
        await authAdmin.updateUser(result.uid, { password: newPassword });

        return res.json({ success: true, email: result.email });
    } catch (err) {
        console.error('[PasswordReset/Confirm]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

async function getCalendarTimezone(accessToken) {
    try {
        const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary',
            { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!r.ok) return 'UTC';
        return (await r.json()).timeZone || 'UTC';
    } catch { return 'UTC'; }
}

// ── Multi-account Google Calendar helpers ──────────────────────────────────
async function getGoogleCalendarAccounts(db, ownerEmail) {
    if (!ownerEmail) return [];
    const snap = await db.collection('users').doc(ownerEmail).get();
    return snap.exists ? (snap.data()?.integrations?.google_calendar_accounts || []) : [];
}

function bookingEnabledAccounts(accounts) {
    return (accounts || []).filter(a => a?.connected && a.enabledForBooking !== false);
}

async function refreshAccountToken(account, ownerEmail, db) {
    let accessToken = account.access_token;
    if (account.refresh_token && account.expiry_date) {
        const expiryMs = new Date(account.expiry_date).getTime();
        if (!isNaN(expiryMs) && expiryMs < Date.now() + 60000) {
            const r = await fetch('https://oauth2.googleapis.com/token', {
                method:  'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body:    new URLSearchParams({
                    client_id:     process.env.GOOGLE_CLIENT_ID,
                    client_secret: process.env.GOOGLE_CLIENT_SECRET,
                    refresh_token: account.refresh_token,
                    grant_type:    'refresh_token',
                }),
            });
            const t = await r.json();
            if (t.access_token) {
                accessToken = t.access_token;
                const newExpiry = new Date(Date.now() + (t.expires_in || 3500) * 1000).toISOString();
                account.access_token = t.access_token;
                account.expiry_date  = newExpiry;
                try {
                    const userRef = db.collection('users').doc(ownerEmail);
                    const snap = await userRef.get();
                    const accounts = snap.exists ? (snap.data()?.integrations?.google_calendar_accounts || []) : [];
                    const idx = accounts.findIndex(a => a.email === account.email);
                    if (idx >= 0) {
                        accounts[idx] = { ...accounts[idx], access_token: t.access_token, expiry_date: newExpiry };
                        await userRef.update({ 'integrations.google_calendar_accounts': accounts });
                    }
                } catch (e) { /* best-effort */ }
            }
        }
    }
    return accessToken;
}

async function deleteCalendarEventsForAppt(db, ownerEmail, appt) {
    if (!ownerEmail) return;
    const accounts = await getGoogleCalendarAccounts(db, ownerEmail);
    const events = (appt.googleCalendarEvents && appt.googleCalendarEvents.length)
        ? appt.googleCalendarEvents
        : (appt.googleCalendarEventId ? [{ accountEmail: accounts[0]?.email || null, eventId: appt.googleCalendarEventId }] : []);
    for (const ev of events) {
        try {
            const acct = accounts.find(a => a.email === ev.accountEmail) || accounts[0];
            if (!acct?.connected) continue;
            const token = await refreshAccountToken(acct, ownerEmail, db);
            await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${ev.eventId}`,
                { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
        } catch (e) { console.error('[Calendar/Delete]', e.message); }
    }
}

async function updateCalendarEventsForAppt(db, ownerEmail, appt) {
    if (!ownerEmail) return;
    const accounts = await getGoogleCalendarAccounts(db, ownerEmail);
    const events = (appt.googleCalendarEvents && appt.googleCalendarEvents.length)
        ? appt.googleCalendarEvents
        : (appt.googleCalendarEventId ? [{ accountEmail: accounts[0]?.email || null, eventId: appt.googleCalendarEventId }] : []);
    for (const ev of events) {
        try {
            const acct = accounts.find(a => a.email === ev.accountEmail) || accounts[0];
            if (!acct?.connected) continue;
            await updateCalendarEvent(acct, ev.eventId, appt, ownerEmail, db);
        } catch (e) { console.error('[Calendar/Update]', e.message); }
    }
}

async function checkCalendarAvailability(account, dateISO, timeStr, ownerEmail, db) {
    try {
        const accessToken = await refreshAccountToken(account, ownerEmail, db);
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

async function addCalendarEvent(account, appt, ownerEmail, db) {
    const accessToken = await refreshAccountToken(account, ownerEmail, db);
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

async function updateCalendarEvent(account, eventId, appt, ownerEmail, db) {
    const accessToken = await refreshAccountToken(account, ownerEmail, db);
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
