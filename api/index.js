import admin from 'firebase-admin';
import crypto from 'crypto';
import { Resend } from 'resend';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

// Vercel Function configuration. Hobby plan clamps to 10s; Pro allows up to 60s.
// The email pipeline is split into two fast jobs so it fits within 10s either way.
export const config = {
    maxDuration: 10,
};

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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-worker-secret');
}

// ════════════════════════════════════════════════════════════════════════════
// PLANS, SEATS, AGENTS, CREDITS & FEATURES — SERVER-SIDE SOURCE OF TRUTH
// ════════════════════════════════════════════════════════════════════════════

const PLAN_LIMITS = {
    free:       { label: 'Free',       maxAgents: 1,   maxSeats: 1,   monthlyCredits: 100    },
    team:       { label: 'Team',       maxAgents: 3,   maxSeats: 3,   monthlyCredits: 2500   },
    teamplus:   { label: 'Team+',      maxAgents: 10,  maxSeats: 10,  monthlyCredits: 10000  },
    enterprise: { label: 'Enterprise', maxAgents: 10,  maxSeats: 10,  monthlyCredits: 45000  },
};

const PLAN_ORDER = ['free', 'team', 'teamplus', 'enterprise'];

const FEATURE_CATALOG = {
    appointmentBooking: { label: 'Appointment Booking',                     plans: ['team', 'teamplus', 'enterprise'] },
    googleCalendar:     { label: 'Google Calendar Auto-Booking',            plans: ['team', 'teamplus', 'enterprise'] },
    pushNotifications:  { label: 'Desktop Push Notifications',              plans: ['team', 'teamplus', 'enterprise'] },
    emailAgent:         { label: 'Email Agent (IMAP/SMTP Inbox)',           plans: ['team', 'teamplus', 'enterprise'] },
    firebaseDatabase:   { label: 'Firebase Live Database Source',           plans: ['teamplus', 'enterprise'] },
    supabaseDatabase:   { label: 'Supabase Live Database Source',           plans: ['teamplus', 'enterprise'] },
    canvaDesign:        { label: 'Canva Design Import',                     plans: ['teamplus', 'enterprise'] },
    figmaDesign:        { label: 'Figma Design Import',                     plans: ['teamplus', 'enterprise'] },
    advancedReports:    { label: 'Full Reports & Feedback (Agent Filter)',  plans: ['teamplus', 'enterprise'] },
};

const DB_SERVICE_FEATURE = { firebase: 'firebaseDatabase', supabase: 'supabaseDatabase' };
const DESIGN_SERVICE_FEATURE = { canva: 'canvaDesign', figma: 'figmaDesign' };

function requiredPlanTiers(featureKey) {
    const def = FEATURE_CATALOG[featureKey];
    if (!def) return [];
    return PLAN_ORDER.filter(t => def.plans.includes(t));
}

function joinWithOr(labels) {
    if (!labels.length) return '';
    if (labels.length === 1) return labels[0];
    return labels.slice(0, -1).join(', ') + ' or ' + labels[labels.length - 1];
}

function buildUpgradeMessage(featureKey) {
    const labels = requiredPlanTiers(featureKey).map(t => PLAN_LIMITS[t].label);
    if (!labels.length) return 'This feature is not available.';
    return `Upgrade to ${joinWithOr(labels)} to unlock this feature.`;
}

function resolveFeatureAccess(tier, overrides) {
    const out = {};
    Object.keys(FEATURE_CATALOG).forEach(key => {
        out[key] = FEATURE_CATALOG[key].plans.includes(tier);
        if (overrides && typeof overrides[key] === 'boolean') out[key] = overrides[key];
    });
    return out;
}

function buildFeatureSnapshot(limits) {
    const out = {};
    Object.keys(FEATURE_CATALOG).forEach(key => {
        const allowed = !!limits.features[key];
        out[key] = {
            allowed,
            label: FEATURE_CATALOG[key].label,
            requiredPlans: requiredPlanTiers(key).map(t => ({ tier: t, label: PLAN_LIMITS[t].label })),
            upgradeMessage: allowed ? null : buildUpgradeMessage(key),
        };
    });
    return out;
}

function featureLockedPayload(featureKey, limits) {
    return {
        success: false,
        featureLocked: featureKey,
        featureLabel: FEATURE_CATALOG[featureKey]?.label || featureKey,
        message: buildUpgradeMessage(featureKey),
        currentPlan: limits ? { tier: limits.tier, label: limits.label } : null,
        requiredPlans: requiredPlanTiers(featureKey).map(t => ({ tier: t, label: PLAN_LIMITS[t].label })),
    };
}

async function checkFeatureForEmail(db, email, featureKey) {
    const ctx = await resolveOwnerContext(db, email);
    const limits = resolvePlanLimits(ctx.ownerProfile);
    return { allowed: !!limits.features[featureKey], ctx, limits };
}

async function denyIfFeatureLocked(res, db, email, featureKey) {
    const access = await checkFeatureForEmail(db, email, featureKey);
    if (access.allowed) return false;
    res.status(403).json(featureLockedPayload(featureKey, access.limits));
    return true;
}

function buildAppUrl(req, origin) {
    return origin ||
           process.env.APP_URL ||
           `https://${String(req.headers.host || '').replace('comex-backend', 'cometchat-ai-platform').replace('.vercel.app', '.web.app')}`;
}

function redirectFeatureLocked(req, res, origin, featureKey, limits) {
    const message = buildUpgradeMessage(featureKey);
    try {
        const url = new URL(buildAppUrl(req, origin));
        url.searchParams.set('feature_locked', featureKey);
        url.searchParams.set('upgrade_message', message);
        return res.redirect(302, url.toString());
    } catch (e) {
        return res.status(403).send(message);
    }
}

async function gateOAuthFeature(req, res, email, origin, featureKey) {
    try {
        const access = await checkFeatureForEmail(getDb(), email, featureKey);
        if (access.allowed) return false;
        redirectFeatureLocked(req, res, origin, featureKey, access.limits);
        return true;
    } catch (err) {
        console.error('[FeatureGate/OAuth]', featureKey, err.message);
        res.status(500).send('Could not verify your plan right now. Please try again.');
        return true;
    }
}

function sanitizeBotDataForPlan(botData, limits) {
    const stripped = [];
    const f = limits.features;

    if (botData.behaviorConfig && botData.behaviorConfig.allowAppointmentBooking && !f.appointmentBooking) {
        botData.behaviorConfig.allowAppointmentBooking = false;
        stripped.push('appointmentBooking');
    }

    const sources = botData.knowledgeContext?.databaseSources;
    if (Array.isArray(sources) && sources.length) {
        const kept = sources.filter(s => {
            const key = DB_SERVICE_FEATURE[s?.service];
            return key && f[key];
        });
        if (kept.length !== sources.length) {
            sources.forEach(s => {
                const key = DB_SERVICE_FEATURE[s?.service] || null;
                if (!key || !f[key]) stripped.push(key || 'databaseSource');
            });
            botData.knowledgeContext.databaseSources = kept;
        }
    }

    if (!f.emailAgent && (botData.agentBuildMode === 'email' || botData.agentBuildMode === 'both')) {
        botData.agentBuildMode = 'widget';
        stripped.push('emailAgent');
    }

    return [...new Set(stripped)];
}

const CREDIT_COSTS = {
    message:       1,
    routing:       1,
    toolFollowUp:  1,
};

const CREDIT_WARNING_THRESHOLD = 0.75;

function currentBillingPeriod(d = new Date()) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function toPositiveInt(v, fallback) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function resolvePlanLimits(userData) {
    const data = userData || {};
    const ent  = data.entitlement || null;

    let tier = 'free';
    let featureOverrides = null;
    if (ent && ent.tier && PLAN_LIMITS[ent.tier]) {
        const notExpired = !ent.expiresAt || new Date(ent.expiresAt).getTime() > Date.now();
        const notRevoked = ent.status !== 'revoked' && ent.status !== 'cancelled';
        if (notExpired && notRevoked) {
            tier = ent.tier;
            featureOverrides = ent.features || null;
        }
    }

    const base = PLAN_LIMITS[tier];
    const overrides = (ent && ent.limits) ? ent.limits : {};

    return {
        tier,
        label:          base.label,
        maxAgents:      toPositiveInt(overrides.maxAgents,      base.maxAgents),
        maxSeats:       toPositiveInt(overrides.maxSeats,       base.maxSeats),
        monthlyCredits: toPositiveInt(overrides.monthlyCredits, base.monthlyCredits),
        features:       resolveFeatureAccess(tier, featureOverrides),
        entitlementSource: ent?.source || 'none',
    };
}

async function resolveOwnerContext(db, email) {
    if (!email) return { ownerEmail: null, isEmployee: false, profile: {}, ownerProfile: {} };
    const snap = await db.collection('users').doc(email).get();
    const profile = snap.exists ? snap.data() : {};

    if (profile.accountType === 'employee' && profile.employerOwnerEmail) {
        const ownerSnap = await db.collection('users').doc(profile.employerOwnerEmail).get();
        return {
            ownerEmail: profile.employerOwnerEmail,
            isEmployee: true,
            profile,
            ownerProfile: ownerSnap.exists ? ownerSnap.data() : {},
        };
    }
    return { ownerEmail: email, isEmployee: false, profile, ownerProfile: profile };
}

async function countActiveAgents(db, ownerEmail) {
    if (!ownerEmail) return 0;
    const snap = await db.collection('user_bots').where('owner', '==', ownerEmail).get();
    let n = 0;
    snap.forEach(d => { if (!d.data()?.deletedAt) n++; });
    return n;
}

async function countOccupiedSeats(db, companyUsername) {
    if (!companyUsername) return 0;
    const snap = await db.collection('users').where('employeeOf', '==', companyUsername).get();
    let n = 0;
    snap.forEach(d => {
        const status = d.data()?.employeeStatus || 'active';
        if (status !== 'removed') n++;
    });
    return n;
}

function readCreditState(userData, limits) {
    const period = currentBillingPeriod();
    const used = userData?.creditPeriod === period ? toPositiveInt(userData.creditsUsed, 0) : 0;
    const limit = limits.monthlyCredits;
    const ratio = limit > 0 ? used / limit : 1;
    return {
        period,
        used,
        limit,
        remaining: Math.max(0, limit - used),
        percentUsed: Math.min(100, Math.round(ratio * 1000) / 10),
        warning: ratio >= CREDIT_WARNING_THRESHOLD && ratio < 1,
        exhausted: used >= limit,
    };
}

async function consumeCredits(db, ownerEmail, amount, opts = {}) {
    if (!ownerEmail || !amount) {
        return { allowed: true, skipped: true, used: 0, limit: 0, remaining: 0, percentUsed: 0, warning: false, exhausted: false };
    }
    const ref = db.collection('users').doc(ownerEmail);

    try {
        return await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const data = snap.exists ? snap.data() : {};
            const limits = resolvePlanLimits(data);
            const state = readCreditState(data, limits);

            if (!opts.force && state.exhausted) {
                return { ...state, allowed: false, tier: limits.tier, reason: 'exhausted' };
            }

            const newUsed = state.used + amount;
            tx.set(ref, {
                creditPeriod:    state.period,
                creditsUsed:     newUsed,
                creditsLimit:    limits.limit || limits.monthlyCredits,
                creditsUpdatedAt: new Date().toISOString(),
            }, { merge: true });

            const ratio = limits.monthlyCredits > 0 ? newUsed / limits.monthlyCredits : 1;
            return {
                allowed: true,
                tier: limits.tier,
                period: state.period,
                used: newUsed,
                limit: limits.monthlyCredits,
                remaining: Math.max(0, limits.monthlyCredits - newUsed),
                percentUsed: Math.min(100, Math.round(ratio * 1000) / 10),
                warning: ratio >= CREDIT_WARNING_THRESHOLD && ratio < 1,
                exhausted: newUsed >= limits.monthlyCredits,
            };
        });
    } catch (err) {
        console.error('[Credits/Consume]', ownerEmail, err.message);
        if (opts.force) return { allowed: true, error: err.message };
        return { allowed: false, reason: 'error', error: err.message, used: 0, limit: 0, remaining: 0, exhausted: true };
    }
}

function addCreditUsage(db, ownerEmail, amount) {
    return consumeCredits(db, ownerEmail, amount, { force: true }).catch(() => null);
}

async function writeEntitlement(db, email, tier, source, limitsOverride, extra = {}) {
    const payload = {
        entitlement: {
            tier,
            source,
            status: 'active',
            grantedAt: new Date().toISOString(),
            expiresAt: null,
            limits: limitsOverride || null,
            ...extra,
        },
        planTier: tier,
    };
    await db.collection('users').doc(email).set(payload, { merge: true });
    return payload.entitlement;
}

async function revokeEntitlement(db, email, reason) {
    await db.collection('users').doc(email).set({
        entitlement: {
            tier: 'free',
            source: 'revoked',
            status: 'active',
            grantedAt: new Date().toISOString(),
            revokedReason: reason || null,
            limits: null,
        },
        planTier: 'free',
    }, { merge: true });
}

async function buildUsageSnapshot(db, requesterEmail) {
    const ctx = await resolveOwnerContext(db, requesterEmail);
    const limits = resolvePlanLimits(ctx.ownerProfile);
    const credits = readCreditState(ctx.ownerProfile, limits);

    const companyUsername = ctx.ownerProfile?.companyUsername || null;
    const [agentsUsed, seatsUsed] = await Promise.all([
        countActiveAgents(db, ctx.ownerEmail),
        countOccupiedSeats(db, companyUsername),
    ]);

    return {
        ownerEmail: ctx.ownerEmail,
        isEmployee: ctx.isEmployee,
        companyUsername,
        plan: {
            tier: limits.tier,
            label: limits.label,
            source: limits.entitlementSource,
        },
        agents: {
            used: agentsUsed,
            limit: limits.maxAgents,
            remaining: Math.max(0, limits.maxAgents - agentsUsed),
            full: agentsUsed >= limits.maxAgents,
        },
        seats: {
            used: seatsUsed,
            limit: limits.maxSeats,
            remaining: Math.max(0, limits.maxSeats - seatsUsed),
            full: seatsUsed >= limits.maxSeats,
        },
        credits,
        features: buildFeatureSnapshot(limits),
        canCreateAgent: !ctx.isEmployee && agentsUsed < limits.maxAgents,
        botsDisabled: credits.exhausted,
        showCreditWarning: credits.warning || credits.exhausted,
    };
}

async function getCompanyCapacity(db, rawUsername) {
    const key = companyKeyFrom(rawUsername);
    if (!key) return null;

    const [companySnap, secretSnap] = await Promise.all([
        db.collection('companies').doc(key).get(),
        db.collection('company_secrets').doc(key).get(),
    ]);
    if (!companySnap.exists || !secretSnap.exists) return null;

    const ownerEmail = secretSnap.data()?.ownerEmail;
    const ownerSnap = ownerEmail ? await db.collection('users').doc(ownerEmail).get() : null;
    const limits = resolvePlanLimits(ownerSnap?.exists ? ownerSnap.data() : {});
    const seatsUsed = await countOccupiedSeats(db, key);

    return {
        companyUsername: key,
        displayUsername: companySnap.data()?.displayUsername || ('@' + key),
        logoBase64: companySnap.data()?.logoBase64 || null,
        planLabel: limits.label,
        seatsUsed,
        maxSeats: limits.maxSeats,
        seatsRemaining: Math.max(0, limits.maxSeats - seatsUsed),
        full: seatsUsed >= limits.maxSeats,
    };
}

// ════════════════════════════════════════════════════════════════════════════
// MULTI-MODEL LLM ROUTER — ALL REQUESTS VIA OPENROUTER
// ════════════════════════════════════════════════════════════════════════════

const MODEL_REGISTRY = {
    'llama-3.2-1b-instruct': { 
        id: 'meta-llama/llama-3.2-1b-instruct', 
        label: 'Llama 3.2 1B Instruct',
        providers: ['Cloudflare', 'Groq']
    },
    'llama-3.1-8b-instruct': { 
        id: 'meta-llama/llama-3.1-8b-instruct', 
        label: 'Llama 3.1 8B Instruct',
        providers: ['Cloudflare', 'Groq']
    },
    'gemma-3-4b':              { id: 'google/gemma-3-4b-it', label: 'Gemma 3 4B' },
    'gemma-3-12b':             { id: 'google/gemma-3-12b-it', label: 'Gemma 3 12B' },
    'deepseek-v4-flash-0423': { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash 0423' },

    'gpt-4o-mini':             { id: 'openai/gpt-4o-mini', label: 'OpenAI GPT-4o mini' },
    'gpt-oss-20b':             { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B (Fast)', providers: ['Groq'] },
    'gemma-3-27b':             { id: 'google/gemma-3-27b-it', label: 'Gemma 3 27B' },
    'deepseek-v4-flash-0731': { id: 'deepseek/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash 0731', providers: ['Cloudflare'] },
    'mistral-nemo':            { id: 'mistralai/mistral-nemo', label: 'Mistral NeMo' },
    'mistral-small-3':         { id: 'mistralai/mistral-small-24b-instruct-2501', label: 'Mistral Small 3' },
    'mistral-small-3.2-24b':   { id: 'mistralai/mistral-small-3.2-24b-instruct', label: 'Mistral Small 3.2 24B' },
    'mistral-small-3.1-24b':   { id: 'mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral Small 3.1 24B', providers: ['Cloudflare'] },
    'microsoft-phi-4':         { id: 'microsoft/phi-4', label: 'Microsoft Phi-4' },

    'gemini-2.5-flash':        { id: 'google/gemini-2.5-flash', label: 'Google Gemini 2.5 Flash', providers: ['Google AI Studio', 'Google'] },
    'gemma-4-26b-a4b':         { id: 'google/gemma-4-26b-a4b-it', label: 'Gemma 4 26B A4B', providers: ['Google AI Studio', 'Google'] },
    'gemma-4-31b':             { id: 'google/gemma-4-31b-it', label: 'Gemma 4 31B', providers: ['Google AI Studio', 'Google'] },
    'qwen-3.8-27b':            { id: 'qwen/qwen3.8-27b', label: 'Alibaba Qwen 3.8 27B', providers: ['Cloudflare'] },

    'llama-3.3-70b-instruct':  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B Instruct', providers: ['Cloudflare'] },
    'llama-4-maverick':        { id: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick' },
    'gpt-oss-120b':            { id: 'openai/gpt-oss-120b', label: 'OpenAI GPT-OSS 120B', providers: ['Groq'] },
    'mistral-saba':            { id: 'mistralai/mistral-saba', label: 'Mistral Saba' },
    'mistral-small-4':         { id: 'mistralai/mistral-small-2603', label: 'Mistral Small 4' },
};

const DEFAULT_MODEL_KEY = 'llama-3.2-1b-instruct';

async function sendOpenRouterRequest(modelKey, messages) {
  const modelConfig = MODEL_REGISTRY[modelKey];
  
  if (!modelConfig) {
    throw new Error(`Model key '${modelKey}' not found in registry.`);
  }

  const payload = {
    model: modelConfig.id,
    messages: messages,
  };

  if (modelConfig.providers && modelConfig.providers.length > 0) {
    payload.provider = {
      order: modelConfig.providers,
      allow_fallbacks: true
    };
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`OpenRouter Error: ${JSON.stringify(errorData)}`);
  }

  return await response.json();
}

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

function sanitizeActionFunctionName(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .substring(0, 64) || 'action';
}

function actionFunctionName(action) {
    return action.id ? sanitizeActionFunctionName(action.id) : sanitizeActionFunctionName(action.name);
}

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

async function executeAgentAction(action, extractedParams) {
    const params = extractedParams && typeof extractedParams === 'object' ? extractedParams : {};
    const method = String(action.method || 'GET').toUpperCase();
    const actionLabel = action.name || 'action';

    try {
        const { url: pathFormattedUrl, usedKeys } = formatActionUrl(action.url, params);

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

function stripThinkingTags(text) {
    if (!text) return text;
    return text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/^[\s\S]*?<\/think>/i, '')
        .trim();
}

async function callLLM({ modelKey, messages, toolChoice, allFieldsPresent, enableBookingTool, extraTools }) {
    const entry = MODEL_REGISTRY[modelKey] || MODEL_REGISTRY[DEFAULT_MODEL_KEY];
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY not set.');

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

    const body = {
        model: entry.id,
        messages,
        ...(hasTools ? { tools, tool_choice: toolChoiceValue } : {}),
        temperature: 0.3,
        max_tokens:  600,
    };

    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer':  process.env.APP_URL || 'https://mebor-ai.com',
            'X-Title':       'Mebor AI',
        },
        body: JSON.stringify(body),
    });

    if (!r.ok) {
        const errText = await r.text();
        throw new Error(`OpenRouter error ${r.status}: ${errText.substring(0, 300)}`);
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

// ════════════════════════════════════════════════════════════════════════════
// LIVE WEBSITE AUTO-SYNC
// ════════════════════════════════════════════════════════════════════════════
const SYNC_CHECK_INTERVAL_MS = 60 * 1000;
const SYNC_FETCH_TIMEOUT_MS  = 5000;
const SYNC_MAX_EXTRA_LINKS   = 3;

function htmlToText(html) {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

async function fetchPageText(url, timeoutMs = SYNC_FETCH_TIMEOUT_MS) {
    const r = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 ComexAI/1.0',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
        },
        cache: 'no-store',
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return htmlToText(await r.text());
}

async function syncBotWebsite(db, businessId, bot, { force = false } = {}) {
    const url = bot.url;
    if (!/^https?:\/\//i.test(url || '')) return { skipped: 'no-url' };

    const lastCheck = bot.lastSyncCheckAt ? new Date(bot.lastSyncCheckAt).getTime() : 0;
    if (!force && Date.now() - lastCheck < SYNC_CHECK_INTERVAL_MS) return { skipped: 'fresh' };

    const botRef = db.collection('user_bots').doc(businessId);
    const nowISO = new Date().toISOString();
    bot.lastSyncCheckAt = nowISO;
    await botRef.set({ lastSyncCheckAt: nowISO }, { merge: true });

    const links = (bot.knowledgeContext?.additionalLinks || [])
        .filter(l => /^https?:\/\//i.test(l || ''))
        .slice(0, SYNC_MAX_EXTRA_LINKS);

    const [main, ...extras] = await Promise.allSettled([
        fetchPageText(url),
        ...links.map(l => fetchPageText(l)),
    ]);

    if (main.status !== 'fulfilled' || main.value.length < 20) {
        const msg = main.status === 'rejected' ? main.reason?.message : 'Page had no readable text.';
        bot.lastSyncError = msg;
        await botRef.set({ lastSyncError: msg }, { merge: true });
        return { error: msg };
    }

    const mainText  = main.value.substring(0, 15000);
    const linksText = extras
        .map((e, i) => (e.status === 'fulfilled' && e.value.length >= 20)
            ? `[Source: ${links[i]}]\n${e.value.substring(0, 4000)}`
            : null)
        .filter(Boolean)
        .join('\n\n');

    const hash = crypto.createHash('sha256').update(mainText + '||' + linksText).digest('hex');

    if (hash === bot.contextHash) {
        bot.lastSyncedAt = nowISO;
        await botRef.set({ lastSyncedAt: nowISO, lastSyncError: null }, { merge: true });
        return { changed: false };
    }

    Object.assign(bot, {
        context: mainText, linksContext: linksText, contextHash: hash,
        lastSyncedAt: nowISO, lastSyncError: null,
    });
    await botRef.set({
        context: mainText, linksContext: linksText, contextHash: hash,
        lastSyncedAt: nowISO, lastSyncError: null,
    }, { merge: true });
    return { changed: true };
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
    if (path === '/api/bot/restore')              return handleBotRestore(req, res);
    if (path === '/api/account/delete-cascade')   return handleAccountDeleteCascade(req, res);
    if (path === '/api/account/update-email')     return handleAccountChangeEmail(req, res);
    if (path === '/api/account/check-exists')     return handleCheckAccountExists(req, res);
    if (path === '/api/password-reset/request') return handlePasswordResetRequest(req, res);
    if (path === '/api/password-reset/verify')  return handlePasswordResetVerify(req, res);
    if (path === '/api/password-reset/confirm') return handlePasswordResetConfirm(req, res);

    if (path === '/api/plan/usage')               return handlePlanUsage(req, res);
    if (path === '/api/plan/features')            return handlePlanFeatures(req, res);
    if (path === '/api/plan/select')              return handlePlanSelect(req, res);
    if (path === '/api/plan/can-create-agent')    return handleCanCreateAgent(req, res);

    if (path === '/api/enterprise/create-checkout') return handleEnterpriseCreateCheckout(req, res);
    if (path === '/api/webhooks/whop')               return handleWhopWebhook(req, res);

    if (path === '/api/email/connect')      return handleEmailConnect(req, res);
    if (path === '/api/email/disconnect')   return handleEmailDisconnect(req, res);
    if (path === '/api/email/status')       return handleEmailStatus(req, res);
    if (path === '/api/email/poll-worker')  return handleEmailPollWorker(req, res);

    // ── Email approval / dashboard endpoints ──
    if (path === '/api/email/pending')       return handleEmailPending(req, res);
    if (path === '/api/email/approve')       return handleEmailApprove(req, res);
    if (path === '/api/email/reject')        return handleEmailReject(req, res);
    if (path === '/api/email/agent-stats')   return handleEmailAgentStats(req, res);

    if (path === '/api/oauth/firebase-project')          return handleFirebaseProjectOAuth(req, res);
    if (path === '/api/oauth/firebase-project/callback')  return handleFirebaseProjectCallback(req, res);
    if (path === '/api/oauth/supabase')                   return handleSupabaseOAuth(req, res);
    if (path === '/api/oauth/supabase/callback')          return handleSupabaseCallback(req, res);
    if (path === '/api/integrations/list-projects')       return handleListProjects(req, res);
    if (path === '/api/integrations/disconnect-database')  return handleDisconnectDatabase(req, res);

    if (path === '/api/oauth/figma')               return handleFigmaOAuth(req, res);
    if (path === '/api/oauth/figma/callback')      return handleFigmaCallback(req, res);
    if (path === '/api/oauth/canva')               return handleCanvaOAuth(req, res);
    if (path === '/api/oauth/canva/callback')      return handleCanvaCallback(req, res);
    if (path === '/api/design/import')             return handleDesignImport(req, res);

    if (path === '/api/company/check-username')           return handleCompanyCheckUsername(req, res);
    if (path === '/api/company/setup')                     return handleCompanySetup(req, res);
    if (path === '/api/company/join-code')                 return handleCompanyJoinCode(req, res);
    if (path === '/api/company/join-code/regenerate'       ) return handleCompanyJoinCodeRegenerate(req, res);
    if (path === '/api/company/capacity')                  return handleCompanyCapacity(req, res);
    if (path === '/api/company/search')                    return handleCompanySearch(req, res);
    if (path === '/api/employee/verify-and-connect')      return handleEmployeeVerifyAndConnect(req, res);
    if (path === '/api/company/employees/list')           return handleCompanyEmployeesList(req, res);
    if (path === '/api/company/employees/remove')         return handleCompanyEmployeeRemove(req, res);
    if (path === '/api/company/employees/disable')        return handleCompanyEmployeeDisable(req, res);
    if (path === '/api/company/employees/delete')         return handleCompanyEmployeeDelete(req, res);
    if (path === '/api/account/update-photo')             return handleUpdateProfilePhoto(req, res);

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
        provider: 'openrouter',
    }));
    return res.json({ success: true, models });
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/plan/usage?email=
// ════════════════════════════════════════════════════════════════════════════
async function handlePlanUsage(req, res) {
    const email = req.query?.email || req.query?.ownerEmail || req.body?.email;
    if (!email) return res.status(400).json({ success: false, message: 'Missing email.' });
    try {
        const db = getDb();
        const usage = await buildUsageSnapshot(db, email);
        return res.json({ success: true, ...usage });
    } catch (err) {
        console.error('[Plan/Usage]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/plan/features?email=
// ════════════════════════════════════════════════════════════════════════════
async function handlePlanFeatures(req, res) {
    const email = req.query?.email || req.query?.ownerEmail || req.body?.email;
    if (!email) return res.status(400).json({ success: false, message: 'Missing email.' });
    try {
        const db = getDb();
        const ctx = await resolveOwnerContext(db, email);
        const limits = resolvePlanLimits(ctx.ownerProfile);
        return res.json({
            success: true,
            plan: { tier: limits.tier, label: limits.label, source: limits.entitlementSource },
            features: buildFeatureSnapshot(limits),
        });
    } catch (err) {
        console.error('[Plan/Features]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/plan/can-create-agent?email=
// ════════════════════════════════════════════════════════════════════════════
async function handleCanCreateAgent(req, res) {
    const email = req.query?.email;
    if (!email) return res.status(400).json({ success: false, message: 'Missing email.' });
    try {
        const db = getDb();
        const usage = await buildUsageSnapshot(db, email);
        return res.json({
            success: true,
            allowed: usage.canCreateAgent,
            reason: usage.isEmployee
                ? 'Employees cannot create agents.'
                : (usage.agents.full ? `Your ${usage.plan.label} plan allows ${usage.agents.limit} deployed agent(s). Delete one or upgrade to add more.` : null),
            agents: usage.agents,
            plan: usage.plan,
        });
    } catch (err) {
        console.error('[Plan/CanCreateAgent]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/plan/select  { email, planKey }
// ════════════════════════════════════════════════════════════════════════════
async function handlePlanSelect(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { email, planKey } = req.body || {};
    if (!email || !planKey) return res.status(400).json({ success: false, message: 'Missing email or planKey.' });
    if (!PLAN_LIMITS[planKey]) return res.status(400).json({ success: false, message: `Unknown plan: ${planKey}` });

    try {
        const db = getDb();
        const userRef = db.collection('users').doc(email);
        const snap = await userRef.get();
        const data = snap.exists ? snap.data() : {};

        if (planKey === 'free') {
            const ent = await writeEntitlement(db, email, 'free', 'self-serve');
            return res.json({ success: true, entitlement: ent, limits: resolvePlanLimits({ entitlement: ent }) });
        }

        if (data.entitlement?.tier === planKey && data.entitlement?.status === 'active') {
            return res.json({ success: true, entitlement: data.entitlement, limits: resolvePlanLimits(data) });
        }

        const promoSnap = await db.collection('promo_codes')
            .where('planKey', '==', planKey)
            .where('redeemedBy', 'array-contains', email)
            .limit(1)
            .get();

        if (!promoSnap.empty) {
            const ent = await writeEntitlement(db, email, planKey, 'promo', null, { promoCode: promoSnap.docs[0].id });
            return res.json({ success: true, entitlement: ent, limits: resolvePlanLimits({ entitlement: ent }) });
        }

        return res.status(402).json({
            success: false,
            message: 'This plan requires an active subscription. Complete checkout to activate it.',
            requiresCheckout: true,
        });
    } catch (err) {
        console.error('[Plan/Select]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// ENTERPRISE DYNAMIC PRICING (WHOP)
// ════════════════════════════════════════════════════════════════════════════

const ENTERPRISE_PRICING = {
    basePrice:        499,
    baseCredits:      45000,   creditOverageRate: 0.010,  maxCredits: 2000000,
    baseAgents:       10,      agentOverageRate:  15,     maxAgents:  5000,
    baseSeats:        10,      seatOverageRate:   10,     maxSeats:   5000,
    maxCheckoutPrice: 2500,
};

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

async function handleEnterpriseCreateCheckout(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { email, companyId, creditPool, agentCount, seatCount } = req.body || {};
    if (!email || creditPool === undefined || creditPool === null)
        return res.status(400).json({ success: false, message: 'Missing email or creditPool.' });

    const { credits, agents, seats, price } = calculateEnterprisePrice(creditPool, agentCount, seatCount);
    if (!(price >= ENTERPRISE_PRICING.basePrice))
        return res.status(400).json({ success: false, message: 'Invalid plan configuration.' });
    if (price > ENTERPRISE_PRICING.maxCheckoutPrice)
        return res.status(400).json({ success: false, message: `This configuration exceeds the $${ENTERPRISE_PRICING.maxCheckoutPrice}/mo self-serve limit. Please contact sales.` });

    const whopApiKey    = process.env.WHOP_API_KEY;
    const whopCompanyId = process.env.WHOP_COMPANY_ID;
    const whopProductId = process.env.WHOP_ENTERPRISE_PRODUCT_ID;
    if (!whopApiKey || !whopCompanyId || !whopProductId) {
        return res.status(500).json({
            success: false,
            message: 'Enterprise checkout is not configured yet. Set WHOP_API_KEY, WHOP_COMPANY_ID, and WHOP_ENTERPRISE_PRODUCT_ID.',
        });
    }

    try {
        const appUrl = process.env.APP_URL || `https://${req.headers.host}`;

        console.log('[Enterprise/CreateCheckout] company_id=', whopCompanyId, 'product_id=', whopProductId, 'price=', price);

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

function whopPlanTierMap() {
    const map = {};
    const pairs = [
        [process.env.WHOP_PLAN_TEAM_MONTHLY,      'team'],
        [process.env.WHOP_PLAN_TEAM_ANNUAL,       'team'],
        [process.env.WHOP_PLAN_TEAMPLUS_MONTHLY,  'teamplus'],
        [process.env.WHOP_PLAN_TEAMPLUS_ANNUAL,   'teamplus'],
    ];
    pairs.forEach(([id, tier]) => { if (id) map[id] = tier; });
    return map;
}

function resolveWhopTier(data, metadata) {
    if (metadata?.tier && PLAN_LIMITS[metadata.tier]) return metadata.tier;
    const planId = data?.plan_id || data?.plan?.id || null;
    const map = whopPlanTierMap();
    if (planId && map[planId]) return map[planId];
    return null;
}

function resolveWhopEmail(data, metadata) {
    return metadata?.owner_email ||
           metadata?.comex_email ||
           data?.user_email ||
           data?.email ||
           data?.user?.email ||
           null;
}

async function handleWhopWebhook(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });

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
        const ownerEmail = resolveWhopEmail(data, metadata);

        if (!ownerEmail) {
            console.warn('[Whop/Webhook] Event missing owner email metadata, ignoring:', type);
            return res.json({ success: true });
        }

        const tier = resolveWhopTier(data, metadata) || 'enterprise';

        if (type === 'membership.went_valid' || type === 'payment.succeeded') {
            if (tier === 'enterprise') {
                const creditPool = parseInt(metadata.credit_pool, 10) || ENTERPRISE_PRICING.baseCredits;
                const agentCount = parseInt(metadata.agent_count, 10) || ENTERPRISE_PRICING.baseAgents;
                const seatCount  = parseInt(metadata.seat_count, 10)  || ENTERPRISE_PRICING.baseSeats;

                await db.collection('users').doc(ownerEmail).set({
                    planUnlockedByPromo: false,
                    enterprise: {
                        monthlyCredits: creditPool,
                        maxAgents: agentCount,
                        maxSeats: seatCount,
                        integrations: {
                            firebase: true, supabase: true, canva: true, figma: true,
                            google_calendar: true, push_alerts: true, email_agent: true,
                        },
                        status: 'active',
                        whopMembershipId: data.id || null,
                        activatedAt: new Date().toISOString(),
                    },
                }, { merge: true });

                await writeEntitlement(db, ownerEmail, 'enterprise', 'whop', {
                    monthlyCredits: creditPool,
                    maxAgents: agentCount,
                    maxSeats: seatCount,
                }, { whopMembershipId: data.id || null });

                console.log(`[Whop/Webhook] Enterprise activated for ${ownerEmail} — ${creditPool} credits, ${agentCount} agents, ${seatCount} seats/mo.`);
            } else {
                await writeEntitlement(db, ownerEmail, tier, 'whop', null, { whopMembershipId: data.id || null });
                console.log(`[Whop/Webhook] ${tier} activated for ${ownerEmail}.`);
            }
        } else if (type === 'membership.went_invalid' || type === 'membership.cancelled') {
            await db.collection('users').doc(ownerEmail).set({
                planUnlockedByPromo: false,
                enterprise: { status: 'cancelled', cancelledAt: new Date().toISOString() },
            }, { merge: true });
            await revokeEntitlement(db, ownerEmail, 'subscription_ended');
            console.log(`[Whop/Webhook] Subscription ended for ${ownerEmail}, downgraded to free.`);
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
// ADVANCED ANALYTICS
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

const FALLBACK_PATTERNS = /don't have (that|this) information|do not have (that|this) information|can only help with questions about this business|i'?m not sure|i am not sure|couldn't find|could not find|don't know the answer|flagged this for our team|speak with a person|connect (you )?(with|to) (a )?(human|team|agent)|live handoff isn't available|isn't available here right now|monthly usage limit/i;

function detectFallback(answer) {
    return FALLBACK_PATTERNS.test(String(answer || ''));
}

const SENTIMENT_NEG = ['angry','frustrat','terrible','worst','hate','awful','useless','broken','disappoint','annoyed','not working',"doesn't work","isn't working",'bad experience','waste of time','horrible','stupid','ridiculous','unacceptable','confusing','complicated','slow','never works','give up','done with this','so bad','no help','not helpful','ridiculous','scam','rude'];
const SENTIMENT_POS = ['thank','thanks','great','awesome','perfect','love','excellent','helpful','amazing','good job','appreciate','wonderful','fantastic','nice','cool','works great','exactly what','solved','sorted','happy','glad'];

function computeSentiment(text) {
    const t = String(text || '').toLowerCase();
    let score = 0;
    SENTIMENT_NEG.forEach(w => { if (t.includes(w)) score -= 1; });
    SENTIMENT_POS.forEach(w => { if (t.includes(w)) score += 1; });
    if (t.includes('!') && score < 0) score -= 0.5;
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

        const fallbackCount = chats.filter(c => c.fallback === true || (c.fallback === undefined && detectFallback(c.answer))).length;
        const fallbackRate = Math.round((fallbackCount / chats.length) * 1000) / 10;

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

        const convMap = {};
        chats.forEach(c => {
            if (!convMap[c.conversationId]) convMap[c.conversationId] = [];
            convMap[c.conversationId].push(c);
        });
        const dropOffMessages = Object.values(convMap)
            .map(msgs => msgs[msgs.length - 1]?.question)
            .filter(Boolean);
        const dropOffClusters = clusterByKeyword(dropOffMessages);

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
        if (cached?.text) return cached.text;
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

    // Clean up email drafts + queued email for this agent
    await deleteQueryBatch(db, db.collection('email_drafts').where('businessId', '==', botId));
    await deleteQueryBatch(db, db.collection('email_queue').where('businessId', '==', botId));

    await botRef.delete().catch(() => {});
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/bot/delete-cascade
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
// POST /api/bot/restore  { businessId, ownerEmail }
// ════════════════════════════════════════════════════════════════════════════
async function handleBotRestore(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { businessId, ownerEmail } = req.body || {};
    if (!businessId || !ownerEmail)
        return res.status(400).json({ success: false, message: 'Missing businessId or ownerEmail.' });

    try {
        const db = getDb();
        const ctx = await resolveOwnerContext(db, ownerEmail);
        if (ctx.isEmployee)
            return res.status(403).json({ success: false, message: 'Only the company owner can restore agents.' });

        const botRef = db.collection('user_bots').doc(businessId);
        const botSnap = await botRef.get();
        if (!botSnap.exists) return res.status(404).json({ success: false, message: 'Agent not found.' });
        if (botSnap.data()?.owner !== ctx.ownerEmail)
            return res.status(403).json({ success: false, message: 'You do not own this agent.' });

        const limits = resolvePlanLimits(ctx.ownerProfile);
        const activeAgents = await countActiveAgents(db, ctx.ownerEmail);
        if (activeAgents >= limits.maxAgents) {
            return res.status(403).json({
                success: false,
                limitReached: 'agents',
                message: `Your ${limits.label} plan allows ${limits.maxAgents} active agent(s). Delete an active agent or upgrade before restoring this one.`,
                agents: { used: activeAgents, limit: limits.maxAgents },
            });
        }

        await botRef.set({ deletedAt: null }, { merge: true });
        return res.json({ success: true });
    } catch (err) {
        console.error('[BotRestore]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/account/delete-cascade
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
        await deleteQueryBatch(db, db.collection('email_drafts').where('ownerEmail', '==', email));
        await deleteQueryBatch(db, db.collection('email_queue').where('ownerEmail', '==', email));

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
// EMAIL AGENT — IMAP/SMTP CONNECTION (Team+ and above)
// feature: emailAgent
// ════════════════════════════════════════════════════════════════════════════

function getEmailCipherKey() {
    const raw = process.env.EMAIL_CRED_KEY;
    if (!raw) throw new Error('Missing EMAIL_CRED_KEY env var (used to encrypt inbox passwords).');
    return crypto.createHash('sha256').update(raw).digest();
}

function encryptEmailPassword(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getEmailCipherKey(), iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptEmailPassword(blob) {
    const buf = Buffer.from(blob, 'base64');
    const iv  = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEmailCipherKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

async function testImapLogin({ host, port, useSSL, address, password }) {
    const client = new ImapFlow({
        host,
        port: Number(port),
        secure: !!useSSL,
        auth: { user: address, pass: password },
        logger: false,
        tls: { rejectUnauthorized: false },
    });
    try {
        await client.connect();
        await client.logout();
        return true;
    } catch (err) {
        try { await client.close(); } catch {}
        throw new Error(err?.responseText || err?.message || 'IMAP login failed.');
    }
}

async function testSmtpLogin({ host, port, useSSL, address, password }) {
    const transporter = nodemailer.createTransport({
        host,
        port: Number(port),
        secure: !!useSSL,
        auth: { user: address, pass: password },
        tls: { rejectUnauthorized: false },
        connectionTimeout: 8000,
        greetingTimeout: 8000,
        socketTimeout: 8000,
    });
    try {
        await transporter.verify();
        return true;
    } catch (err) {
        throw new Error(err?.response || err?.message || 'SMTP login failed.');
    }
}

// Shared helper: sends an outbound email through the owner's connected inbox
async function sendEmailViaSMTP(emailCfg, password, { to, subject, text }) {
    const transporter = nodemailer.createTransport({
        host: emailCfg.smtpHost,
        port: emailCfg.smtpPort,
        secure: !!emailCfg.useSSL,
        auth: { user: emailCfg.address, pass: password },
        tls: { rejectUnauthorized: false },
        connectionTimeout: 5000,
        greetingTimeout:   5000,
        socketTimeout:     8000,
    });
    return transporter.sendMail({
        from: emailCfg.address,
        to,
        subject,
        text,
    });
}

// Parse the "DD:HH:MM" auto-send delay string into milliseconds.
// Defaults to 2 minutes when missing/invalid.
function parseAutoSendDelay(delayStr) {
    const s = String(delayStr || '').trim();
    const m = s.match(/^(\d{1,3}):(\d{2}):(\d{2})$/);
    if (!m) return 2 * 60 * 1000;
    const days  = parseInt(m[1], 10);
    const hours = parseInt(m[2], 10);
    const mins  = parseInt(m[3], 10);
    const totalMinutes = ((days * 24 + hours) * 60 + mins);
    return totalMinutes * 60 * 1000;
}

// POST /api/email/connect
async function handleEmailConnect(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const {
        ownerEmail, address, password,
        imapHost, imapPort, smtpHost, smtpPort, useSSL,
    } = req.body || {};

    if (!ownerEmail || !address || !password || !imapHost || !imapPort || !smtpHost || !smtpPort) {
        return res.status(400).json({ success: false, message: 'Missing required email connection fields.' });
    }

    try {
        const db = getDb();

        // Plan gate — Email Agent is Team+ and above.
        if (await denyIfFeatureLocked(res, db, ownerEmail, 'emailAgent')) return;

        // 1. IMAP handshake
        try {
            await testImapLogin({ host: imapHost, port: imapPort, useSSL, address, password });
        } catch (err) {
            return res.status(400).json({
                success: false,
                failureStage: 'imap',
                message: `IMAP login failed: ${err.message}`,
            });
        }

        // 2. SMTP handshake
        try {
            await testSmtpLogin({ host: smtpHost, port: smtpPort, useSSL, address, password });
        } catch (err) {
            return res.status(400).json({
                success: false,
                failureStage: 'smtp',
                message: `SMTP login failed: ${err.message}`,
            });
        }

        // 3. Save encrypted credentials + settings
        await db.collection('users').doc(ownerEmail).set({
            integrations: {
                email: {
                    connected: true,
                    address,
                    imapHost,
                    imapPort: Number(imapPort),
                    smtpHost,
                    smtpPort: Number(smtpPort),
                    useSSL: !!useSSL,
                    passwordEnc: encryptEmailPassword(password),
                    connectedAt: new Date().toISOString(),
                    lastFetchAt: null,
                    lastFetchError: null,
                    lastReplyAt: null,
                    lastReplyError: null,
                },
            },
        }, { merge: true });

        return res.json({ success: true, message: 'Inbox connected.' });
    } catch (err) {
        console.error('[Email/Connect]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// POST /api/email/disconnect
async function handleEmailDisconnect(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { ownerEmail } = req.body || {};
    if (!ownerEmail) return res.status(400).json({ success: false, message: 'Missing ownerEmail.' });

    try {
        const db = getDb();
        await db.collection('users').doc(ownerEmail).set({
            integrations: { email: null },
        }, { merge: true });

        // Clear any dangling pending/scheduled drafts so the dashboard doesn't
        // show orphans after the inbox is gone.
        try {
            const draftsSnap = await db.collection('email_drafts')
                .where('ownerEmail', '==', ownerEmail)
                .where('status', 'in', ['pending', 'scheduled'])
                .get();
            const batch = db.batch();
            draftsSnap.docs.forEach(d => batch.update(d.ref, {
                status: 'abandoned',
                abandonedAt: new Date().toISOString(),
            }));
            if (!draftsSnap.empty) await batch.commit();
        } catch (e) { console.warn('[Email/Disconnect/Drafts]', e.message); }

        return res.json({ success: true, message: 'Inbox disconnected.' });
    } catch (err) {
        console.error('[Email/Disconnect]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// GET /api/email/status?ownerEmail=
async function handleEmailStatus(req, res) {
    const { ownerEmail } = req.query;
    if (!ownerEmail) return res.status(400).json({ success: false, message: 'Missing ownerEmail.' });
    try {
        const db = getDb();
        const snap = await db.collection('users').doc(ownerEmail).get();
        const email = snap.exists ? (snap.data()?.integrations?.email || null) : null;
        if (!email?.connected) return res.json({ success: true, connected: false });
        return res.json({
            success: true,
            connected: true,
            address: email.address,
            lastFetchAt: email.lastFetchAt || null,
            lastFetchError: email.lastFetchError || null,
            lastReplyAt: email.lastReplyAt || null,
            lastReplyError: email.lastReplyError || null,
        });
    } catch (err) {
        console.error('[Email/Status]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// EMAIL DASHBOARD ENDPOINTS (pending / approve / reject / stats)
// ════════════════════════════════════════════════════════════════════════════

// GET /api/email/pending?ownerEmail=
async function handleEmailPending(req, res) {
    const { ownerEmail } = req.query;
    if (!ownerEmail) return res.status(400).json({ success: false, message: 'Missing ownerEmail.' });
    try {
        const db = getDb();
        const snap = await db.collection('email_drafts')
            .where('ownerEmail', '==', ownerEmail)
            .where('status', '==', 'pending')
            .get();

        const pending = [];
        snap.forEach(d => pending.push({ id: d.id, ...d.data() }));

        // Newest first
        pending.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

        return res.json({ success: true, pending });
    } catch (err) {
        console.error('[Email/Pending]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// POST /api/email/approve  { draftId, businessId?, ownerEmail, finalResponse }
async function handleEmailApprove(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { draftId, ownerEmail, finalResponse } = req.body || {};
    if (!draftId || !ownerEmail || !finalResponse) {
        return res.status(400).json({ success: false, message: 'Missing draftId, ownerEmail, or finalResponse.' });
    }

    try {
        const db = getDb();
        const draftRef = db.collection('email_drafts').doc(draftId);
        const draftSnap = await draftRef.get();
        if (!draftSnap.exists) return res.status(404).json({ success: false, message: 'Draft not found.' });

        const draft = draftSnap.data();
        if (draft.ownerEmail !== ownerEmail) {
            return res.status(403).json({ success: false, message: 'You do not own this draft.' });
        }
        if (draft.status !== 'pending') {
            return res.status(409).json({ success: false, message: `This draft is already ${draft.status}.` });
        }

        // Load inbox config
        const userSnap = await db.collection('users').doc(ownerEmail).get();
        const emailCfg = userSnap.data()?.integrations?.email;
        if (!emailCfg?.connected) {
            return res.status(400).json({ success: false, message: 'Your email inbox is disconnected. Reconnect it before approving.' });
        }
        const password = decryptEmailPassword(emailCfg.passwordEnc);

        // Send via SMTP
        await sendEmailViaSMTP(emailCfg, password, {
            to: draft.fromEmail,
            subject: `Re: ${draft.subject || '(no subject)'}`,
            text: finalResponse,
        });

        // Mark as sent
        const now = new Date().toISOString();
        await draftRef.set({
            status: 'sent',
            finalResponse,
            approvedAt: now,
            sentAt: now,
            approvedBy: ownerEmail,
        }, { merge: true });

        // Also mark the corresponding queue item as done, if it exists
        if (draft.queueId) {
            try {
                await db.collection('email_queue').doc(draft.queueId).set({
                    status: 'done',
                    replyText: finalResponse,
                    processedAt: now,
                    approvedBy: ownerEmail,
                }, { merge: true });
            } catch (e) { /* best-effort */ }
        }

        // Log it in the agent's chat history for analytics
        if (draft.businessId) {
            await logChat(db, draft.businessId, `email-${draftId}`, draft.originalQuery || '', finalResponse, true, false, { source: 'email' });
        }

        // Best-effort status update on the user doc
        try {
            await db.collection('users').doc(ownerEmail).set({
                integrations: { email: { lastReplyAt: now, lastReplyError: null } },
            }, { merge: true });
        } catch {}

        return res.json({ success: true, message: 'Reply approved and sent.' });
    } catch (err) {
        console.error('[Email/Approve]', err.message);

        // Try to persist the failure so the dashboard can surface it
        try {
            if (req.body?.draftId) {
                await getDb().collection('email_drafts').doc(req.body.draftId).set({
                    status: 'failed',
                    error: err.message,
                    failedAt: new Date().toISOString(),
                }, { merge: true });
            }
        } catch {}

        return res.status(500).json({ success: false, message: err.message });
    }
}

// POST /api/email/reject  { draftId, ownerEmail }
async function handleEmailReject(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { draftId, ownerEmail } = req.body || {};
    if (!draftId || !ownerEmail) {
        return res.status(400).json({ success: false, message: 'Missing draftId or ownerEmail.' });
    }

    try {
        const db = getDb();
        const draftRef = db.collection('email_drafts').doc(draftId);
        const snap = await draftRef.get();
        if (!snap.exists) return res.status(404).json({ success: false, message: 'Draft not found.' });

        const draft = snap.data();
        if (draft.ownerEmail !== ownerEmail) {
            return res.status(403).json({ success: false, message: 'You do not own this draft.' });
        }
        if (draft.status !== 'pending') {
            return res.status(409).json({ success: false, message: `This draft is already ${draft.status}.` });
        }

        const now = new Date().toISOString();
        await draftRef.set({
            status: 'rejected',
            rejectedAt: now,
            rejectedBy: ownerEmail,
        }, { merge: true });

        // Mark queue item so it doesn't get picked up again
        if (draft.queueId) {
            try {
                await db.collection('email_queue').doc(draft.queueId).set({
                    status: 'rejected',
                    rejectedAt: now,
                }, { merge: true });
            } catch (e) { /* best-effort */ }
        }

        return res.json({ success: true });
    } catch (err) {
        console.error('[Email/Reject]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// GET /api/email/agent-stats?businessId=&ownerEmail=
async function handleEmailAgentStats(req, res) {
    const { businessId, ownerEmail } = req.query;
    if (!businessId || !ownerEmail) {
        return res.status(400).json({ success: false, message: 'Missing businessId or ownerEmail.' });
    }
    try {
        const db = getDb();

        // Verify ownership
        const botSnap = await db.collection('user_bots').doc(businessId).get();
        if (!botSnap.exists) return res.status(404).json({ success: false, message: 'Agent not found.' });
        if (botSnap.data()?.owner !== ownerEmail) {
            return res.status(403).json({ success: false, message: 'You do not own this agent.' });
        }

        // Pending = drafts waiting for approval
        // Sent = drafts that were sent (approved) — auto-sent ones counted via queue below
        const [pendingSnap, sentSnap, queueSentSnap] = await Promise.all([
            db.collection('email_drafts')
                .where('businessId', '==', businessId)
                .where('status', '==', 'pending')
                .get(),
            db.collection('email_drafts')
                .where('businessId', '==', businessId)
                .where('status', '==', 'sent')
                .get(),
            db.collection('email_queue')
                .where('businessId', '==', businessId)
                .where('status', '==', 'done')
                .get(),
        ]);

        return res.json({
            success: true,
            pending: pendingSnap.size,
            sent: sentSnap.size + queueSentSnap.size,
        });
    } catch (err) {
        console.error('[Email/AgentStats]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/email/poll-worker
//
// Split into two jobs so it stays under Vercel Hobby's 10-second function cap:
//   • Even UTC minute  → FETCH job  (IMAP → Firestore `email_queue`)
//   • Odd  UTC minute  → REPLY job  (queue → LLM → SMTP or email_drafts)
//
// The REPLY job also first sends any `scheduled` drafts whose scheduledAt has
// already passed (from agents where auto-send is ON but with a delay).
// ════════════════════════════════════════════════════════════════════════════
const EMAIL_TICK_BUDGET_MS = 8000;          // hard cap — leave 2s headroom before Vercel kills us
const EMAIL_MAX_INBOXES_PER_FETCH = 3;      // inboxes visited per fetch run
const EMAIL_REPLY_BATCH_SIZE = 5;           // parallel SMTP+LLM sends per reply run
const EMAIL_SCHEDULED_BATCH_SIZE = 5;       // scheduled drafts processed per reply run

async function handleEmailPollWorker(req, res) {
    const cronSecret = process.env.EMAIL_WORKER_SECRET;
    const isCloudflareCron = /cloudflare|worker/i.test(req.headers['user-agent'] || '');
    if (cronSecret && !isCloudflareCron && req.headers['x-worker-secret'] !== cronSecret) {
        return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }

    const minute = new Date().getUTCMinutes();
    const job = (minute % 2 === 0) ? 'fetch' : 'reply';

    try {
        const db = getDb();
        const startedAt = Date.now();
        const result = (job === 'fetch')
            ? await runEmailFetchJob(db, startedAt)
            : await runEmailReplyJob(db, startedAt);
        return res.json({ success: true, job, elapsedMs: Date.now() - startedAt, ...result });
    } catch (err) {
        console.error('[Email/Tick]', err.message);
        return res.status(500).json({ success: false, job, message: err.message });
    }
}

// ────────────────────────────────────────────────────────────────────────────
// JOB A — FETCH: connect to each connected inbox, pull UNSEEN emails into the
// `email_queue` Firestore collection, mark them Seen. NO LLM, NO SMTP.
// ────────────────────────────────────────────────────────────────────────────
async function runEmailFetchJob(db, startedAt) {
    const usersSnap = await db.collection('users').get();
    const targets = [];
    usersSnap.forEach(d => {
        const em = d.data()?.integrations?.email;
        if (em?.connected) targets.push({ email: d.id, config: em });
    });

    const inboxes = targets.slice(0, EMAIL_MAX_INBOXES_PER_FETCH);
    const results = [];

    for (const t of inboxes) {
        if (Date.now() - startedAt > EMAIL_TICK_BUDGET_MS - 2000) {
            results.push({ email: t.email, skipped: 'time-budget' });
            break;
        }

        try {
            const r = await fetchOneInbox(db, t.email, t.config, startedAt);
            results.push({ email: t.email, ...r });
        } catch (err) {
            console.error('[Email/Fetch]', t.email, err.message);
            results.push({ email: t.email, error: err.message });
            try {
                await db.collection('users').doc(t.email).set({
                    integrations: { email: { lastFetchError: err.message, lastFetchAt: new Date().toISOString() } },
                }, { merge: true });
            } catch {}
        }
    }

    return { queued: results.reduce((s, r) => s + (r.queued || 0), 0), results };
}

async function fetchOneInbox(db, ownerEmail, config, startedAt) {
    const password = decryptEmailPassword(config.passwordEnc);

    const client = new ImapFlow({
        host: config.imapHost,
        port: config.imapPort,
        secure: !!config.useSSL,
        auth: { user: config.address, pass: password },
        logger: false,
        tls: { rejectUnauthorized: false },
        connectionTimeout: 5000,
        greetingTimeout:   5000,
        socketTimeout:     8000,
    });

    // CRITICAL: without this listener, async socket errors crash the whole Node process.
    let socketError = null;
    client.on('error', (err) => { socketError = err; });

    let lock = null;
    let queued = 0;

    try {
        await client.connect();
        if (socketError) throw socketError;

        lock = await client.getMailboxLock('INBOX');

        // Find the owner's email-capable agent before we start queuing, so the
        // reply job has everything it needs stored on the queue doc.
        const botsSnap = await db.collection('user_bots').where('owner', '==', ownerEmail).get();
        let emailAgent = null;
        botsSnap.forEach(d => {
            const b = d.data();
            if (b.deletedAt) return;
            if ((b.agentBuildMode === 'email' || b.agentBuildMode === 'both') && !emailAgent) {
                emailAgent = { id: d.id, name: b.displayName || b.name || 'Assistant' };
            }
        });
        if (!emailAgent) return { skipped: 'no-email-agent' };

        // ── FIX: Only process emails that arrived AFTER the inbox was
        // connected. Anything older is silently marked Seen and skipped, so
        // a freshly-connected inbox full of historical unread mail doesn't
        // get flooded with auto-replies. ──
        const connectedAtMs = config.connectedAt ? new Date(config.connectedAt).getTime() : 0;
        // If connectedAt is missing (legacy rows), fall back to 24h ago so we
        // never accidentally process ancient mail.
        const cutoffMs = connectedAtMs || (Date.now() - 24 * 60 * 60 * 1000);

        const uids = await client.search({ seen: false }, { uid: true });
        const batch = uids || [];

        for (const uid of batch) {
            if (Date.now() - startedAt > EMAIL_TICK_BUDGET_MS - 1500) break;
            if (socketError) break;

            try {
                const msg = await client.fetchOne(
                    uid,
                    { envelope: true, source: true, internalDate: true },
                    { uid: true }
                );
                if (!msg) continue;

                const fromEmail = msg.envelope?.from?.[0]?.address;
                if (!fromEmail) continue;

                // ── Skip pre-connection emails (Bug 1 fix) ──
                const receivedMs = msg.internalDate ? new Date(msg.internalDate).getTime() : 0;
                if (receivedMs && receivedMs < cutoffMs - 60_000) {
                    // Mark as Seen so it's never picked up again, but don't queue it.
                    try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch {}
                    continue;
                }

                // Idempotency: don't queue the same UID twice for the same user.
                const queueRef = db.collection('email_queue').doc(`${ownerEmail}__${uid}`);
                const existing = await queueRef.get();
                if (existing.exists) {
                    try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch {}
                    continue;
                }

                await queueRef.set({
                    ownerEmail,
                    businessId: emailAgent.id,
                    botName: emailAgent.name,
                    fromEmail,
                    subject: msg.envelope?.subject || '(no subject)',
                    bodyText: extractEmailBody(msg.source.toString('utf8')),
                    status: 'pending',
                    createdAt: new Date().toISOString(),
                });

                try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch {}

                queued++;
            } catch (inner) {
                console.error('[Email/Fetch/Message]', inner.message);
            }
        }

        await db.collection('users').doc(ownerEmail).set({
            integrations: { email: { lastFetchAt: new Date().toISOString(), lastFetchError: null } },
        }, { merge: true });

        return { queued };
    } finally {
        try { if (lock) lock.release(); } catch {}
        try { await client.logout(); } catch {}
    }
}

// ────────────────────────────────────────────────────────────────────────────
// JOB B — REPLY:
//   1. First: send any `scheduled` drafts whose scheduledAt has passed.
//   2. Then: pull up to 5 pending emails from the queue and process them
//      IN PARALLEL. LLM + (SMTP OR draft-write) calls run concurrently.
//
// Branch on emailConfig.requireHumanApproval:
//   • TRUE  → write email_drafts { status: 'pending' } + FCM push, no send.
//   • FALSE → if delay > 0: write email_drafts { status: 'scheduled' };
//             else send now and mark queue done.
// ────────────────────────────────────────────────────────────────────────────
async function runEmailReplyJob(db, startedAt) {
    // Step 1 — send due scheduled drafts
    const scheduledResult = await processDueScheduledDrafts(db, startedAt);

    // Step 2 — process new queue items
    const queueSnap = await db.collection('email_queue')
        .where('status', '==', 'pending')
        .orderBy('createdAt', 'asc')
        .limit(EMAIL_REPLY_BATCH_SIZE)
        .get();

    if (queueSnap.empty) {
        return { processed: 0, results: [], scheduledSent: scheduledResult.sent || 0 };
    }

    const items = queueSnap.docs.map(d => ({ ref: d.ref, id: d.id, ...d.data() }));

    // Group by owner so we can batch-consume credits per user atomically.
    const byOwner = {};
    items.forEach(it => {
        (byOwner[it.ownerEmail] ||= []).push(it);
    });

    const approvedIds = new Set();
    const skipped = [];

    for (const [ownerEmail, group] of Object.entries(byOwner)) {
        const credit = await consumeCredits(db, ownerEmail, CREDIT_COSTS.message * group.length);
        if (credit.allowed) {
            group.forEach(it => approvedIds.add(it.id));
        } else {
            for (const it of group) {
                skipped.push(it.id);
                await it.ref.set({
                    status: 'skipped',
                    reason: 'no-credits',
                    skippedAt: new Date().toISOString(),
                }, { merge: true });
            }
        }
    }

    const activeItems = items.filter(it => approvedIds.has(it.id));
    if (!activeItems.length) {
        return {
            processed: 0,
            skipped: skipped.length,
            results: [],
            scheduledSent: scheduledResult.sent || 0,
        };
    }

    const settled = await Promise.allSettled(
        activeItems.map(it => processQueuedEmail(db, it.id, it, startedAt))
    );

    const results = settled.map((r, i) => {
        const id = activeItems[i].id;
        return r.status === 'fulfilled'
            ? { id, ...r.value }
            : { id, error: r.reason?.message || 'unknown' };
    });

    return {
        processed: activeItems.length,
        skipped: skipped.length,
        results,
        scheduledSent: scheduledResult.sent || 0,
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Process drafts whose scheduledAt has passed and send them via SMTP.
// ────────────────────────────────────────────────────────────────────────────
async function processDueScheduledDrafts(db, startedAt) {
    try {
        const nowISO = new Date().toISOString();
        const snap = await db.collection('email_drafts')
            .where('status', '==', 'scheduled')
            .where('scheduledAt', '<=', nowISO)
            .limit(EMAIL_SCHEDULED_BATCH_SIZE)
            .get();

        if (snap.empty) return { sent: 0, failed: 0 };

        const results = await Promise.allSettled(
            snap.docs.map(d => sendScheduledDraft(db, d.id, d.data()))
        );

        let sent = 0, failed = 0;
        results.forEach(r => {
            if (r.status === 'fulfilled' && r.value?.sent) sent++;
            else failed++;
        });

        return { sent, failed };
    } catch (e) {
        console.error('[Email/ScheduledSend]', e.message);
        return { sent: 0, failed: 0, error: e.message };
    }
}

async function sendScheduledDraft(db, draftId, draft) {
    const draftRef = db.collection('email_drafts').doc(draftId);

    // Reload to make sure status hasn't changed (e.g. user approved/rejected)
    const fresh = await draftRef.get();
    if (!fresh.exists) return { skipped: 'not-found' };
    const d = fresh.data();
    if (d.status !== 'scheduled') return { skipped: 'not-scheduled' };

    // Load email config
    const userSnap = await db.collection('users').doc(d.ownerEmail).get();
    const emailCfg = userSnap.data()?.integrations?.email;
    if (!emailCfg?.connected) {
        await draftRef.set({
            status: 'failed',
            error: 'inbox-disconnected',
            failedAt: new Date().toISOString(),
        }, { merge: true });
        return { error: 'inbox-disconnected' };
    }
    const password = decryptEmailPassword(emailCfg.passwordEnc);

    try {
        await sendEmailViaSMTP(emailCfg, password, {
            to: d.fromEmail,
            subject: `Re: ${d.subject || '(no subject)'}`,
            text: d.draftedResponse,
        });

        const now = new Date().toISOString();
        await draftRef.set({
            status: 'sent',
            sentAt: now,
            autoSent: true,
        }, { merge: true });

        if (d.businessId) {
            await logChat(db, d.businessId, `email-${draftId}`, d.originalQuery || '', d.draftedResponse, true, false, { source: 'email' });
        }

        try {
            await db.collection('users').doc(d.ownerEmail).set({
                integrations: { email: { lastReplyAt: now, lastReplyError: null } },
            }, { merge: true });
        } catch {}

        return { sent: true };
    } catch (err) {
        console.error('[Email/ScheduledSend/Draft]', draftId, err.message);
        await draftRef.set({
            status: 'failed',
            error: err.message,
            failedAt: new Date().toISOString(),
        }, { merge: true });
        return { error: err.message };
    }
}

async function processQueuedEmail(db, queueId, item, startedAt) {
    const queueRef = db.collection('email_queue').doc(queueId);

    const botSnap = await db.collection('user_bots').doc(item.businessId).get();
    if (!botSnap.exists) {
        await queueRef.set({ status: 'failed', error: 'agent-not-found', failedAt: new Date().toISOString() }, { merge: true });
        return { error: 'agent-not-found' };
    }
    const bot = botSnap.data();

    // ── Email-specific config: approval + auto-send delay ──
    const emailConfig = bot.emailConfig || {};
    const requireHumanApproval = emailConfig.requireHumanApproval !== false;   // default: ON
    const autoSendDelay = emailConfig.autoSendDelay || '00:00:02';

    const ctx = await resolveOwnerContext(db, item.ownerEmail);
    const limits = resolvePlanLimits(ctx.ownerProfile);
    if (!limits.features.emailAgent) {
        await queueRef.set({ status: 'skipped', reason: 'plan-lost-email-feature', skippedAt: new Date().toISOString() }, { merge: true });
        return { skipped: 'plan' };
    }

    // Resolve inbox config again (may have changed since queue time)
    const userSnap = await db.collection('users').doc(item.ownerEmail).get();
    const emailCfg = userSnap.data()?.integrations?.email;
    if (!emailCfg?.connected) {
        await queueRef.set({ status: 'failed', error: 'inbox-disconnected', failedAt: new Date().toISOString() }, { merge: true });
        return { error: 'inbox-disconnected' };
    }
    const password = decryptEmailPassword(emailCfg.passwordEnc);

    // ── LLM call to draft the reply ──
    const sysPrompt = bot.knowledgeContext?.systemPrompt
        || `You are a helpful assistant replying to an email. Keep replies concise and professional.`;
    const webContext = bot.context ? `\n\n[WEBSITE CONTENT]:\n${bot.context}` : '';

    const choice = await callLLM({
        modelKey: bot.modelKey || DEFAULT_MODEL_KEY,
        messages: [
            { role: 'system', content: sysPrompt + webContext + `\n\nTHIS IS AN EMAIL REPLY. Write a clear, professional reply. Do NOT mention chat, widgets, or "typing". Include a brief sign-off.` },
            { role: 'user', content: item.bodyText },
        ],
        enableBookingTool: false,
    });
    const replyText = choice?.content?.trim() || 'Thanks for your message.';

    const nowISO = new Date().toISOString();

    // ── BRANCH 1: Human approval required → stage as pending draft ──
    if (requireHumanApproval) {
        const draftRef = await db.collection('email_drafts').add({
            ownerEmail: item.ownerEmail,
            businessId: item.businessId,
            botName: item.botName || bot.displayName || bot.name || 'Email Agent',
            fromEmail: item.fromEmail,
            subject: item.subject || '(no subject)',
            originalQuery: item.bodyText,
            draftedResponse: replyText,
            status: 'pending',
            queueId,
            createdAt: nowISO,
        });

        // Fire a push notification so the owner can review quickly.
        // Purpose='email' so only devices connected to the Email Push card
        // receive it (Bug 3 fix).
        try {
            await sendFCMToUser(item.ownerEmail, buildEmailApprovalNotification({
                id: draftRef.id,
                fromEmail: item.fromEmail,
                originalQuery: item.bodyText,
                botName: item.botName || bot.name || 'Email Agent',
            }), 'email');
        } catch (e) {
            console.error('[Email/ApprovalFCM]', e.message);
        }

        await queueRef.set({
            status: 'awaiting-approval',
            draftId: draftRef.id,
            approvalRequestedAt: nowISO,
        }, { merge: true });

        return { awaitingApproval: true, draftId: draftRef.id };
    }

    // ── BRANCH 2: Auto-send (with optional delay) ──
    const delayMs = parseAutoSendDelay(autoSendDelay);

    // Immediate send (delay = 0)
    if (delayMs <= 0) {
        await sendEmailViaSMTP(emailCfg, password, {
            to: item.fromEmail,
            subject: `Re: ${item.subject || '(no subject)'}`,
            text: replyText,
        });

        await queueRef.set({
            status: 'done',
            replyText,
            processedAt: nowISO,
            elapsedMs: Date.now() - startedAt,
        }, { merge: true });

        await logChat(db, item.businessId, `email-${queueId}`, item.bodyText, replyText, true, false, { source: 'email' });

        try {
            await db.collection('users').doc(item.ownerEmail).set({
                integrations: { email: { lastReplyAt: nowISO, lastReplyError: null } },
            }, { merge: true });
        } catch {}

        return { handled: true, elapsedMs: Date.now() - startedAt };
    }

    // Scheduled send
    const scheduledAt = new Date(Date.now() + delayMs).toISOString();
    const draftRef = await db.collection('email_drafts').add({
        ownerEmail: item.ownerEmail,
        businessId: item.businessId,
        botName: item.botName || bot.displayName || bot.name || 'Email Agent',
        fromEmail: item.fromEmail,
        subject: item.subject || '(no subject)',
        originalQuery: item.bodyText,
        draftedResponse: replyText,
        status: 'scheduled',
        scheduledAt,
        queueId,
        createdAt: nowISO,
    });

    await queueRef.set({
        status: 'scheduled',
        draftId: draftRef.id,
        scheduledAt,
    }, { merge: true });

    return { scheduled: true, draftId: draftRef.id, scheduledAt };
}

function extractEmailBody(raw) {
    const idx = raw.indexOf('\r\n\r\n') >= 0 ? raw.indexOf('\r\n\r\n') : raw.indexOf('\n\n');
    const body = idx >= 0 ? raw.substring(idx + 4) : raw;
    if (/content-type:\s*multipart/i.test(raw)) {
        const parts = body.split(/--[^\r\n]+/);
        const texts = parts.filter(p => /content-type:\s*text\/plain/i.test(p));
        if (texts.length) return texts[0].replace(/content-type:[^\n]+\n/i, '').replace(/content-transfer-encoding:[^\n]+\n/i, '').trim();
        const htmlParts = parts.filter(p => /content-type:\s*text\/html/i.test(p));
        if (htmlParts.length) return htmlParts[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 8000);
}

// ════════════════════════════════════════════════════════════════════════════
// FCM — PUSH NOTIFICATION HELPERS
// ════════════════════════════════════════════════════════════════════════════

// purpose: 'push'  → appointment / general notifications
//          'email' → email-approval notifications
// Each purpose maintains its own token array so the two integration cards
// (Push Notifications vs Email Push Notifications) track independent state.
async function sendFCMToUser(ownerEmail, { title, body, url, tag, type }, purpose = 'push') {
    if (!ownerEmail) return { sent: 0, failed: 0 };

    const db = getDb();

    try {
        const ctx = await resolveOwnerContext(db, ownerEmail);
        const limits = resolvePlanLimits(ctx.ownerProfile);
        if (!limits.features.pushNotifications) return { sent: 0, failed: 0, skipped: 'plan' };
    } catch (e) {
        console.error('[FCM/PlanGate]', e.message);
        return { sent: 0, failed: 0, skipped: 'plan-check-failed' };
    }

    const userRef = db.collection('users').doc(ownerEmail);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return { sent: 0, failed: 0 };

    const userData = userSnap.data();

    // ── Pick tokens by purpose ──
    const tokens = purpose === 'email'
        ? (Array.isArray(userData.fcmEmailTokens) ? userData.fcmEmailTokens : [])
        : (Array.isArray(userData.fcmPushTokens) ? userData.fcmPushTokens
            : (Array.isArray(userData.fcmTokens) ? userData.fcmTokens : []));

    if (!tokens.length) return { sent: 0, failed: 0, skipped: 'no-tokens-for-purpose' };

    const messaging = getMessaging();

    // ── Include webpush.notification so the browser auto-displays the alert
    // even when the tab is in the background and even if the service worker
    // isn't manually handling background messages. (Bug 2 fix.) ──
    const message = {
        tokens,
        data: {
            title: title || 'Mebor AI Notification',
            body:  body  || '',
            url:   url   || '/',
            tag:   tag   || 'comex-general',
            purpose,
            ...(type ? { type } : {}),
        },
        notification: {
            title: title || 'Mebor AI Notification',
            body:  body  || '',
        },
        webpush: {
            notification: {
                title: title || 'Mebor AI Notification',
                body:  body  || '',
                icon:  '/media/mebor_logo.png',
                badge: '/media/mebor_logo.png',
                tag:   tag || 'comex-general',
            },
            fcmOptions: { link: url || '/' },
        },
    };

    let result;
    try {
        result = await messaging.sendEachForMulticast(message);
    } catch (err) {
        console.error('[FCM] sendEachForMulticast failed:', err.message);
        return { sent: 0, failed: tokens.length, error: err.message };
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
        if (purpose === 'email') {
            const remaining = (userData.fcmEmailTokens || []).filter(t => !deadTokens.includes(t));
            await userRef.update({ fcmEmailTokens: remaining });
        } else {
            const remainingPush = (userData.fcmPushTokens || userData.fcmTokens || []).filter(t => !deadTokens.includes(t));
            const remainingLegacy = (userData.fcmTokens || []).filter(t => !deadTokens.includes(t));
            await userRef.update({ fcmPushTokens: remainingPush, fcmTokens: remainingLegacy });
        }
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
        tag:   'Mebor-appointment',
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

function buildCreditWarningNotification(percentUsed, limit) {
    return {
        title: '⚠️ 75% of Monthly Credits Used',
        body:  `Your workspace has used ${percentUsed}% of its ${limit.toLocaleString()} monthly credits. Agents stop responding at 100%.`,
        url:   '/?view=pricing',
        tag:   'comex-credit-warning',
    };
}

function buildCreditExhaustedNotification(limit) {
    return {
        title: '🛑 Monthly Credits Exhausted',
        body:  `All ${limit.toLocaleString()} credits for this month have been used. Your agents are paused until the next cycle or an upgrade.`,
        url:   '/?view=pricing',
        tag:   'comex-credit-exhausted',
    };
}

function buildEmailApprovalNotification(draft) {
    const preview = String(draft.originalQuery || '').replace(/\s+/g, ' ').trim().substring(0, 110);
    const from = draft.fromEmail || 'someone';
    return {
        title: `✉️ New email draft from ${from}`,
        body:  `${preview}${preview.length >= 110 ? '…' : ''} — open your Email Dashboard to approve or edit.`,
        url:   '/email-dashboard',
        tag:   `email-approval-${draft.id || Date.now()}`,
        type:  'email_approval',
    };
}

async function maybeNotifyCreditThreshold(db, ownerEmail, state) {
    if (!ownerEmail || !state || state.skipped) return;
    try {
        const ref = db.collection('users').doc(ownerEmail);
        const snap = await ref.get();
        const data = snap.exists ? snap.data() : {};
        const alerts = data.creditAlerts || {};
        const period = state.period || currentBillingPeriod();

        if (state.exhausted && alerts.exhaustedPeriod !== period) {
            await ref.set({ creditAlerts: { ...alerts, exhaustedPeriod: period } }, { merge: true });
            await notifyOwnerAndEmployees(db, ownerEmail, buildCreditExhaustedNotification(state.limit)).catch(() => {});
        } else if (state.warning && alerts.warningPeriod !== period) {
            await ref.set({ creditAlerts: { ...alerts, warningPeriod: period } }, { merge: true });
            await notifyOwnerAndEmployees(db, ownerEmail, buildCreditWarningNotification(state.percentUsed, state.limit)).catch(() => {});
        }
    } catch (e) { console.warn('[Credits/Notify]', e.message); }
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
    const { userEmail, fcmToken, purpose = 'push' } = req.body || {};
    if (!userEmail || !fcmToken)
        return res.status(400).json({ success: false, message: 'Missing userEmail or fcmToken.' });

    if (!['push', 'email'].includes(purpose))
        return res.status(400).json({ success: false, message: 'purpose must be "push" or "email".' });

    try {
        const db      = getDb();

        if (await denyIfFeatureLocked(res, db, userEmail, 'pushNotifications')) return;

        const userRef  = db.collection('users').doc(userEmail);
        const snap     = await userRef.get();
        const data     = snap.exists ? snap.data() : {};

        const field          = purpose === 'email' ? 'fcmEmailTokens' : 'fcmPushTokens';
        const existing       = Array.isArray(data[field]) ? data[field] : [];
        const legacyExisting = Array.isArray(data.fcmTokens) ? data.fcmTokens : [];

        const newTokens = existing.includes(fcmToken) ? existing : [...existing, fcmToken];
        const newLegacy = legacyExisting.includes(fcmToken) ? legacyExisting : [...legacyExisting, fcmToken];

        await userRef.set({
            [field]:  newTokens,
            fcmTokens: newLegacy,                        // keep legacy array in sync
            notificationsEnabled: true,
            notificationsConnectedAt: new Date().toISOString(),
        }, { merge: true });

        return res.json({ success: true, message: 'Device registered for notifications.', purpose });
    } catch (err) {
        console.error('[FCM-Register]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

async function handleFCMRemoveToken(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { userEmail, fcmToken, purpose = 'push' } = req.body || {};
    if (!userEmail) return res.status(400).json({ success: false, message: 'Missing userEmail.' });

    if (!['push', 'email'].includes(purpose))
        return res.status(400).json({ success: false, message: 'purpose must be "push" or "email".' });

    try {
        const db      = getDb();
        const userRef  = db.collection('users').doc(userEmail);
        const snap     = await userRef.get();
        if (!snap.exists) return res.json({ success: true });

        const data = snap.data();
        const field = purpose === 'email' ? 'fcmEmailTokens' : 'fcmPushTokens';
        const existing = Array.isArray(data[field]) ? data[field] : [];
        const remaining = fcmToken ? existing.filter(t => t !== fcmToken) : [];

        // Keep legacy array in sync by recomputing from both purpose arrays.
        const emailTokens = purpose === 'email' ? remaining : (data.fcmEmailTokens || []);
        const pushTokens  = purpose === 'push'  ? remaining : (data.fcmPushTokens  || []);
        const legacy = [...new Set([...emailTokens, ...pushTokens])];

        await userRef.update({
            [field]: remaining,
            fcmTokens: legacy,
        });

        return res.json({ success: true, message: 'Notifications disconnected.', purpose });
    } catch (err) {
        console.error('[FCM-Remove]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

async function handleFCMTestNotification(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { userEmail, purpose = 'push' } = req.body || {};
    if (!userEmail) return res.status(400).json({ success: false, message: 'Missing userEmail.' });

    if (!['push', 'email'].includes(purpose))
        return res.status(400).json({ success: false, message: 'purpose must be "push" or "email".' });

    try {
        if (await denyIfFeatureLocked(res, getDb(), userEmail, 'pushNotifications')) return;

        const result = await sendFCMToUser(userEmail, {
            title: purpose === 'email' ? '✅ Email Alerts Connected!' : '✅ Notifications Connected!',
            body:  purpose === 'email'
                ? 'This is a test alert from Mebor AI. You will receive one like this for every email draft that needs approval.'
                : 'This is a test alert from Mebor AI. You will receive one like this for every new appointment.',
            url:   '/?view=integrations',
            tag:   'comex-test',
            type:  'test',
        }, purpose);

        if (result.skipped) {
            return res.status(400).json({
                success: false,
                message: `Test notification skipped: ${result.skipped}.`,
                skipped: result.skipped,
            });
        }
        if (result.sent === 0) {
            return res.status(400).json({
                success: false,
                message: `No active devices found. (${result.failed || 0} failed, ${result.error || 'no error details'})`,
                failed: result.failed,
                error:  result.error,
            });
        }

        return res.json({ success: true, message: `Test notification sent to ${result.sent} device(s).`, sent: result.sent });
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
        const db = getDb();
        const ctx = await resolveOwnerContext(db, ownerEmail);

        if (ctx.isEmployee) {
            return res.status(403).json({
                success: false,
                message: 'Employees cannot create or edit agents — only the company owner can.',
            });
        }

        const botRef = db.collection('user_bots').doc(botData.id);
        const existingSnap = await botRef.get();
        const isExisting = existingSnap.exists && !existingSnap.data()?.deletedAt;

        if (existingSnap.exists && existingSnap.data()?.owner && existingSnap.data().owner !== ctx.ownerEmail) {
            return res.status(403).json({ success: false, message: 'That agent ID belongs to another account.' });
        }

        const limits = resolvePlanLimits(ctx.ownerProfile);

        if (!isExisting) {
            const activeAgents = await countActiveAgents(db, ctx.ownerEmail);
            if (activeAgents >= limits.maxAgents) {
                return res.status(403).json({
                    success: false,
                    limitReached: 'agents',
                    message: `Your ${limits.label} plan includes ${limits.maxAgents} deployed agent(s) and you already have ${activeAgents}. Delete an agent or upgrade your plan to deploy another.`,
                    agents: { used: activeAgents, limit: limits.maxAgents },
                    plan: { tier: limits.tier, label: limits.label },
                });
            }
        }

        if (!botData.modelKey || !MODEL_REGISTRY[botData.modelKey]) {
            botData.modelKey = DEFAULT_MODEL_KEY;
        }

        // Normalize agentBuildMode — anything but widget/email/both becomes widget.
        const VALID_MODES = ['widget', 'email', 'both'];
        if (!VALID_MODES.includes(botData.agentBuildMode)) {
            botData.agentBuildMode = 'widget';
        }

        // Normalize emailConfig so the reply job always reads a sane value.
        if (botData.agentBuildMode === 'email' || botData.agentBuildMode === 'both') {
            const ec = botData.emailConfig || {};
            botData.emailConfig = {
                requireHumanApproval: ec.requireHumanApproval !== false,
                autoSendDelay: /^\d{1,3}:\d{2}:\d{2}$/.test(String(ec.autoSendDelay || ''))
                    ? ec.autoSendDelay
                    : '00:00:02',
            };
        }

        const featuresStripped = sanitizeBotDataForPlan(botData, limits);

        botData.owner     = ctx.ownerEmail;
        botData.deletedAt = null;
        botData.displayName = botData.displayName || botData.name;
        botData.createdAt = botData.createdAt || new Date().toISOString();
        await botRef.set(botData, { merge: true });

        const agentsUsed = await countActiveAgents(db, ctx.ownerEmail);
        return res.status(200).json({
            success: true,
            botId: botData.id,
            agents: { used: agentsUsed, limit: limits.maxAgents, remaining: Math.max(0, limits.maxAgents - agentsUsed) },
            plan: { tier: limits.tier, label: limits.label },
            modelKey: botData.modelKey,
            agentBuildMode: botData.agentBuildMode,
            ...(featuresStripped.length ? {
                featuresStripped,
                featureWarnings: featuresStripped.map(k => ({
                    feature: k,
                    label: FEATURE_CATALOG[k]?.label || k,
                    message: FEATURE_CATALOG[k] ? buildUpgradeMessage(k) : 'Not available on your plan.',
                })),
            } : {}),
        });
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
        const text = (await fetchPageText(url, 12000)).substring(0, 15000);
        if (text.length < 20) throw new Error('Could not extract text from this URL.');

        const nowISO = new Date().toISOString();
        const update = {
            url,
            context: text,
            contextHash: crypto.createHash('sha256').update(text + '||').digest('hex'),
            lastSyncedAt: nowISO,
            lastSyncCheckAt: nowISO,
            lastSyncError: null,
        };
        if (customInstructions) update.knowledgeContext = { systemPrompt: customInstructions };
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
        const db = getDb();
        const snap = await db.collection('user_bots').doc(businessId).get();
        if (!snap.exists) return res.status(404).json({ success: false, error: 'Bot not found.' });
        const b = snap.data();

        let serviceAvailable = true;
        let planFeatures = null;
        try {
            if (b.owner) {
                const ownerSnap = await db.collection('users').doc(b.owner).get();
                const limits = resolvePlanLimits(ownerSnap.exists ? ownerSnap.data() : {});
                const credits = readCreditState(ownerSnap.exists ? ownerSnap.data() : {}, limits);
                serviceAvailable = !credits.exhausted;
                planFeatures = limits.features;
            }
        } catch (e) { /* best-effort */ }

        const behaviorConfig = Object.assign({
            allowOutOfTopic:      true,
            allowWebSearch:       true,
            allowHallucination:   false,
            allowAppointmentBooking: false,
            allowHumanHandoff:    true,
        }, b.behaviorConfig || {});
        if (planFeatures && !planFeatures.appointmentBooking) behaviorConfig.allowAppointmentBooking = false;

        return res.status(200).json({
            success:         true,
            name:            b.displayName || b.name    || 'AI Assistant',
            internalName:    b.name                     || null,
            agentBuildMode:  b.agentBuildMode           || 'widget',
            position:        b.position                 || 'bottom-right',
            logoBase64:      b.logoBase64               || null,
            themeColor:      b.designConfig?.themeColor || '#0f172a',
            designConfig:    b.designConfig             || {},
            modelKey:        b.modelKey                 || DEFAULT_MODEL_KEY,
            serviceAvailable,
            behaviorConfig,
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
// CHAT
// ════════════════════════════════════════════════════════════════════════════
async function handleChat(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { businessId, message, question, history = [], conversationId: inId } = req.body || {};
    const userMsg = message || question;
    const source = req.body?.source === 'email' ? 'email' : 'web';

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
        let planLimits = resolvePlanLimits({});
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
            modelKey   = MODEL_REGISTRY[b.modelKey] ? b.modelKey : DEFAULT_MODEL_KEY;
            subAgents  = Array.isArray(b.subAgents) ? b.subAgents.filter(a => a?.id && a?.systemPrompt) : [];
            agentActionsList = Array.isArray(b.agentActions) ? b.agentActions.filter(a => a?.name && a?.url) : [];
            behaviorConfig = Object.assign(behaviorConfig, b.behaviorConfig || {});

            if (b.deletedAt) {
                const reply = 'This assistant is not available right now. Please contact the business directly.';
                return res.json({ success: true, answer: reply, reply, _unavailable: true });
            }

            if (ownerEmail) {
                try {
                    const ownerPlanSnap = await db.collection('users').doc(ownerEmail).get();
                    planLimits = resolvePlanLimits(ownerPlanSnap.exists ? ownerPlanSnap.data() : {});
                } catch (e) {
                    console.error('[Chat/PlanLookup]', e.message);
                }
            }
            if (!planLimits.features.appointmentBooking) behaviorConfig.allowAppointmentBooking = false;

            try { await syncBotWebsite(db, businessId, b); }
            catch (e) { console.warn('[Chat/Sync]', e.message); }

            const kc   = b.knowledgeContext || {};
            if (kc.systemPrompt) {
                sysPrompt = kc.systemPrompt;
            } else {
                sysPrompt = `You are a helpful, friendly customer service assistant for "${botName}". Use the business information below to answer questions accurately.`;
            }
            if (b.context) {
                sysPrompt += `\n\n[WEBSITE CONTENT — LIVE, last synced ${b.lastSyncedAt || 'at deploy time'}]:\n${b.context}`;
                if (b.linksContext) sysPrompt += `\n\n[REFERENCE LINKS — LIVE]:\n${b.linksContext}`;
                sysPrompt += `\n\nThe website content above is the current source of truth. If earlier messages in this conversation contradict it, the website content is correct and the earlier messages are outdated.`;
            }
            if (kc.fileContents) {
                sysPrompt += `\n\n[REFERENCE DOCUMENTS]:\n${String(kc.fileContents).substring(0, 6000)}`;
            }

            const dbSources = (kc.databaseSources || []).filter(s => {
                const featureKey = DB_SERVICE_FEATURE[s?.service];
                return featureKey && planLimits.features[featureKey];
            });
            if (dbSources.length) {
                const limitedSources = dbSources.slice(0, 3);
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

        if (agentActionsList.length) {
            sysPrompt += `\n\nAUTONOMOUS ACTIONS:\n- You have access to real, live tools/actions that call external systems on this business's behalf (e.g. checking an order status, updating a record, triggering a webhook).\n- Call the matching tool whenever the user's request matches what that tool does, using the AI Description of each tool to decide when it applies.\n- Extract every required parameter directly from the conversation. If a required parameter is missing, ask the user for it before calling the tool.\n- After a tool result comes back, use it to give a clear, natural-language answer — never show the user raw JSON.\n- If a tool call fails or times out, apologize briefly and let the user know the action could not be completed right now.`;
        }

        if (source === 'email') {
            sysPrompt += `\n\nTHIS IS AN EMAIL REPLY. The user's message arrived via email. Write a clear, professional reply. Do NOT mention chat, widgets, or "typing". Include a brief sign-off.`;
        }

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

        const creditState = await consumeCredits(db, ownerEmail, CREDIT_COSTS.message);
        if (!creditState.allowed) {
            const reply = creditState.reason === 'exhausted'
                ? "I'm offline for the moment — this assistant has reached its monthly message limit. Please reach out to the business directly and they'll get back to you."
                : "I'm having trouble responding right now. Please try again in a moment.";
            await logChat(db, businessId, convId, userMsg, reply, false, false, {
                fallback: true,
                creditBlocked: true,
            });
            if (creditState.reason === 'exhausted') {
                maybeNotifyCreditThreshold(db, ownerEmail, { ...creditState, exhausted: true, period: currentBillingPeriod() });
            }
            return res.json({
                success: true,
                answer: reply,
                reply,
                _creditsExhausted: creditState.reason === 'exhausted',
                _credits: { used: creditState.used, limit: creditState.limit, remaining: 0 },
            });
        }
        maybeNotifyCreditThreshold(db, ownerEmail, creditState);

        const creditMeta = {
            used: creditState.used,
            limit: creditState.limit,
            remaining: creditState.remaining,
            percentUsed: creditState.percentUsed,
            warning: creditState.warning,
        };

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
            return res.json({ success: true, answer: reply, reply, _credits: creditMeta });
        }

        if (bookingEnabled && ((isCancelConfirm && isPendingCancel) || (msgLower === 'yes, cancel' || msgLower === 'yes cancel'))) {
            const appt = await findConversationAppointment();
            if (!appt) {
                const reply = "I couldn't find an active appointment to cancel. Please contact us directly.";
                return res.json({ success: true, answer: reply, reply, _credits: creditMeta });
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
                return res.json({ success: true, answer: reply, reply, _credits: creditMeta });
            } catch {
                const reply = 'There was an error cancelling your appointment. Please try again.';
                return res.json({ success: true, answer: reply, reply, _credits: creditMeta });
            }
        }

        if (isEditIntent && !isPendingEdit && !isPendingEditValue) {
            const reply = `Which detail would you like to change?\n\n1. **Name**\n2. **Contact info** (email/phone)\n3. **Date**\n4. **Time**\n\nPlease type the number or the field name.`;
            await logChat(db, businessId, convId, userMsg, reply, false, false);
            return res.json({ success: true, answer: reply, reply, _credits: creditMeta });
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
                return res.json({ success: true, answer: reply, reply, _credits: creditMeta });
            }
            const fieldLabels = { customerName: 'name', contactInfo: 'contact info', appointmentDay: 'date', appointmentTime: 'time' };
            const reply = `What would you like to change the ${fieldLabels[field]} to?`;
            await logChat(db, businessId, convId, userMsg, reply, false, false);
            return res.json({ success: true, answer: reply, reply, _editField: field, _credits: creditMeta });
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
                    return res.json({ success: true, answer: reply, reply, _credits: creditMeta });
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

        let routedAgent = null;
        if (subAgents.length) {
            routedAgent = await routeToSubAgent(modelKey, userMsg, subAgents);
            await addCreditUsage(db, ownerEmail, CREDIT_COSTS.routing);
            if (routedAgent) {
                sysPrompt += `\n\n[ACTIVE SPECIALIZED AGENT: ${routedAgent.name}]\nYou are now acting as this specialized agent. Follow its instructions closely while still respecting the behavior settings above.\n${routedAgent.systemPrompt}`;
            }
        }

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
            catch { return res.json({ success: true, answer: 'Could you confirm your booking details again?', _credits: creditMeta }); }

            const { userName, contactInfo, appointmentDay, appointmentTime } = args;

            if (!appointmentTime || appointmentTime.trim() === '' || /^tbd$/i.test(appointmentTime.trim())) {
                return res.json({
                    success: true,
                    answer:  `Got it! Just one more thing — what time works best for you on ${appointmentDay}?`,
                    _credits: creditMeta,
                });
            }
            if (!userName || !contactInfo || !appointmentDay) {
                return res.json({
                    success: true,
                    answer:  'I need your name, contact info, preferred date and time to complete the booking. What would you like to provide?',
                    _credits: creditMeta,
                });
            }

            const dateISO = resolveDay(appointmentDay);

            let bookingAccounts = [];
            if (ownerEmail && planLimits.features.googleCalendar) {
                bookingAccounts = bookingEnabledAccounts(await getGoogleCalendarAccounts(db, ownerEmail));
                if (bookingAccounts.length) {
                    const avail = await checkCalendarAvailability(bookingAccounts[0], dateISO, appointmentTime, ownerEmail, db);
                    if (!avail.available) {
                        const alts    = avail.suggestedTimes || [];
                        const altText = alts.length > 0
                            ? '\n\nHere are 3 available slots on that day:\n' + alts.map((t, i) => `  ${i + 1}. ${t}`).join('\n') + '\n\nWhich one works for you?'
                            : '\n\nWould you like to pick a different date or time?';
                        return res.json({ success: true, answer: `Sorry, ${appointmentTime} on ${appointmentDay} is already booked.${altText}`, _credits: creditMeta });
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

            return res.json({ success: true, answer, reply: answer, _credits: creditMeta });
        }

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
                    await addCreditUsage(db, ownerEmail, CREDIT_COSTS.toolFollowUp);
                    if (followUpChoice?.content) followUpChoice.content = stripThinkingTags(followUpChoice.content);
                } catch (err) {
                    console.error('[AgentActions/FollowUp]', err.message);
                    const fallbackAnswer = "I ran that action, but had trouble putting together a response. Could you ask again?";
                    await logChat(db, businessId, convId, userMsg, fallbackAnswer, true, false, { fallback: true });
                    return res.json({ success: true, answer: fallbackAnswer, reply: fallbackAnswer, _actionsExecuted: executed.map(e => e.functionName), _credits: creditMeta });
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
                    _credits: creditMeta,
                });
            }
        }

        const answer = choice?.content?.trim() || 'How can I help you?';
        await logChat(db, businessId, convId, userMsg, answer, true, false);
        return res.json({ success: true, answer, reply: answer, _agent: routedAgent?.name || null, _credits: creditMeta });

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
// PROMO CODES
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

            return { success: true, planKey: promo.planKey, promoLimits: promo.limits || null };
        });

        if (!result.success) {
            const isGone = /expired|no longer active|reached its redemption limit/i.test(result.message || '');
            return res.status(isGone ? 410 : 404).json(result);
        }

        if (!PLAN_LIMITS[result.planKey]) {
            return res.status(400).json({ success: false, message: 'This promo code is misconfigured. Please contact support.' });
        }

        const entitlement = await writeEntitlement(
            db, email, result.planKey, 'promo', result.promoLimits || null, { promoCode: normalizedCode }
        );
        const limits = resolvePlanLimits({ entitlement });

        await db.collection('users').doc(email).set({ planUnlockedByPromo: true }, { merge: true });

        return res.json({
            success: true,
            planKey: result.planKey,
            limits: {
                maxAgents: limits.maxAgents,
                maxSeats: limits.maxSeats,
                monthlyCredits: limits.monthlyCredits,
            },
            features: buildFeatureSnapshot(limits),
        });
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

    if (await gateOAuthFeature(req, res, email, origin, 'googleCalendar')) return;

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

    if (await gateOAuthFeature(req, res, email, origin, 'googleCalendar')) return;

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

async function handleToggleCalendarAccount(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { userEmail, calendarId, enabled } = req.body || {};
    if (!userEmail || !calendarId)
        return res.status(400).json({ success: false, message: 'Missing userEmail or calendarId.' });

    try {
        const db = getDb();

        if (await denyIfFeatureLocked(res, db, userEmail, 'googleCalendar')) return;

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
// FIREBASE PROJECT OAUTH (data source)
// ════════════════════════════════════════════════════════════════════════════
async function handleFirebaseProjectOAuth(req, res) {
    const { email, origin } = req.query;
    if (!email) return res.status(400).send('Missing email.');

    if (await gateOAuthFeature(req, res, email, origin, 'firebaseDatabase')) return;

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

    if (await gateOAuthFeature(req, res, email, origin, 'firebaseDatabase')) return;

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
// SUPABASE OAUTH
// ════════════════════════════════════════════════════════════════════════════
async function handleSupabaseOAuth(req, res) {
    const { email, origin } = req.query;
    if (!email) return res.status(400).send('Missing email.');

    if (await gateOAuthFeature(req, res, email, origin, 'supabaseDatabase')) return;

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

    if (await gateOAuthFeature(req, res, email, origin, 'supabaseDatabase')) return;

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
// FIGMA OAUTH
// ════════════════════════════════════════════════════════════════════════════
async function handleFigmaOAuth(req, res) {
    const { email, origin } = req.query;
    if (!email) return res.status(400).send('Missing email.');

    if (await gateOAuthFeature(req, res, email, origin, 'figmaDesign')) return;

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

    if (await gateOAuthFeature(req, res, email, origin, 'figmaDesign')) return;

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
// CANVA OAUTH (PKCE)
// ════════════════════════════════════════════════════════════════════════════
function base64url(buffer) {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function handleCanvaOAuth(req, res) {
    const { email, origin } = req.query;
    if (!email) return res.status(400).send('Missing email.');

    if (await gateOAuthFeature(req, res, email, origin, 'canvaDesign')) return;

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

    if (await gateOAuthFeature(req, res, email, origin, 'canvaDesign')) return;

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

        if (await denyIfFeatureLocked(res, db, ownerEmail, DESIGN_SERVICE_FEATURE[service])) return;

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
                    extracted.logoUrl = 'figma-image-ref';
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
// GET /api/integrations/list-projects
// ════════════════════════════════════════════════════════════════════════════
async function handleListProjects(req, res) {
    const { service, ownerEmail } = req.query;
    if (!service || !ownerEmail)
        return res.status(400).json({ success: false, message: 'Missing service or ownerEmail.' });

    try {
        const db = getDb();

        const featureKey = DB_SERVICE_FEATURE[service];
        if (featureKey && await denyIfFeatureLocked(res, db, ownerEmail, featureKey)) return;

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
// POST /api/integrations/disconnect-database
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
// GET /api/company/check-username
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
// GET /api/company/capacity
// ════════════════════════════════════════════════════════════════════════════
async function handleCompanyCapacity(req, res) {
    const { companyUsername } = req.query;
    if (!companyUsername) return res.status(400).json({ success: false, message: 'Missing companyUsername.' });
    try {
        const db = getDb();
        const capacity = await getCompanyCapacity(db, companyUsername);
        if (!capacity) return res.status(404).json({ success: false, message: 'Company not found.' });
        return res.json({ success: true, ...capacity });
    } catch (err) {
        console.error('[Company/Capacity]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/company/search
// ════════════════════════════════════════════════════════════════════════════
async function handleCompanySearch(req, res) {
    const q = companyKeyFrom(req.query?.q || '');
    if (!q) return res.json({ success: true, companies: [] });
    try {
        const db = getDb();
        const snap = await db.collection('companies')
            .orderBy(admin.firestore.FieldPath.documentId())
            .startAt(q)
            .endAt(q + '\uf8ff')
            .limit(8)
            .get();

        const companies = [];
        for (const d of snap.docs) {
            const capacity = await getCompanyCapacity(db, d.id);
            if (capacity) {
                companies.push(capacity);
            } else {
                const c = d.data() || {};
                companies.push({
                    companyUsername: d.id,
                    displayUsername: c.displayUsername || ('@' + d.id),
                    logoBase64: c.logoBase64 || null,
                    planLabel: 'Free',
                    seatsUsed: 0,
                    maxSeats: PLAN_LIMITS.free.maxSeats,
                    seatsRemaining: PLAN_LIMITS.free.maxSeats,
                    full: false,
                });
            }
        }
        return res.json({ success: true, companies });
    } catch (err) {
        console.error('[Company/Search]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/company/setup
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

        const existingUserSnap = await db.collection('users').doc(ownerEmail).get();
        const existingCompanyUsername = existingUserSnap.exists ? existingUserSnap.data()?.companyUsername : null;
        if (existingCompanyUsername) {
            return res.status(409).json({
                success: false,
                message: `This account is already set up with the company "@${existingCompanyUsername}". Contact support if you believe this is wrong.`,
            });
        }

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

        const existing = existingUserSnap.exists ? existingUserSnap.data() : {};
        if (!existing.entitlement) {
            await writeEntitlement(db, ownerEmail, 'free', 'signup');
        }

        return res.json({ success: true, key });
    } catch (err) {
        console.error('[Company/Setup]', err.message);
        return res.status(400).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/company/join-code
// ════════════════════════════════════════════════════════════════════════════
async function handleCompanyJoinCode(req, res) {
    const { companyUsername, requestedBy } = req.query;
    if (!companyUsername || !requestedBy)
        return res.status(400).json({ success: false, message: 'Missing companyUsername or requestedBy.' });
    try {
        const db = getDb();
        const { key, secret } = await requireCompanyOwner(db, companyUsername, requestedBy);
        const { code, expiresAt } = await ensureValidJoinCode(db, key, secret);

        const ownerSnap = await db.collection('users').doc(requestedBy).get();
        const limits = resolvePlanLimits(ownerSnap.exists ? ownerSnap.data() : {});
        const seatsUsed = await countOccupiedSeats(db, key);

        return res.json({
            success: true,
            joinCode: code,
            expiresAt,
            seats: {
                used: seatsUsed,
                limit: limits.maxSeats,
                remaining: Math.max(0, limits.maxSeats - seatsUsed),
                full: seatsUsed >= limits.maxSeats,
            },
            plan: { tier: limits.tier, label: limits.label },
        });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ success: false, message: err.message });
        console.error('[Company/JoinCode]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/company/join-code/regenerate
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
// POST /api/employee/verify-and-connect
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

        const employeeSnap = await db.collection('users').doc(employeeEmail).get();
        const employeeProfile = employeeSnap.exists ? employeeSnap.data() : {};
        const isRejoin = employeeProfile.employeeOf === key && (employeeProfile.employeeStatus || 'active') !== 'removed';

        if (!isRejoin) {
            const ownerSnap = secret.ownerEmail ? await db.collection('users').doc(secret.ownerEmail).get() : null;
            const limits = resolvePlanLimits(ownerSnap?.exists ? ownerSnap.data() : {});
            const seatsUsed = await countOccupiedSeats(db, key);
            if (seatsUsed >= limits.maxSeats) {
                return res.status(403).json({
                    success: false,
                    limitReached: 'seats',
                    message: `This company's ${limits.label} plan is full (${seatsUsed}/${limits.maxSeats} team members). Ask the owner to upgrade or free up a seat.`,
                    seats: { used: seatsUsed, limit: limits.maxSeats },
                });
            }
        }

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
// GET /api/company/employees/list
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

        const ownerSnap = await db.collection('users').doc(requestedBy).get();
        const limits = resolvePlanLimits(ownerSnap.exists ? ownerSnap.data() : {});
        const seatsUsed = employees.filter(e => e.status !== 'removed').length;

        return res.json({
            success: true,
            employees,
            seats: {
                used: seatsUsed,
                limit: limits.maxSeats,
                remaining: Math.max(0, limits.maxSeats - seatsUsed),
                full: seatsUsed >= limits.maxSeats,
            },
            plan: { tier: limits.tier, label: limits.label },
        });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ success: false, message: err.message });
        console.error('[Company/EmployeesList]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/company/employees/remove
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

        return res.json({ success: true, message: 'Employee removed from company. Their seat is now free.' });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ success: false, message: err.message });
        console.error('[Company/EmployeeRemove]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/company/employees/disable
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

        return res.json({ success: true, message: isDisabling ? 'Employee account disabled (still holds a seat).' : 'Employee account re-enabled.' });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ success: false, message: err.message });
        console.error('[Company/EmployeeDisable]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/company/employees/delete
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

        return res.json({ success: true, message: 'Employee account permanently deleted. Their seat is now free.' });
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
// GET /api/human/list
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
// POST /api/human/connect
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
// POST /api/human/send-message
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
// GET /api/human/poll
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
// POST /api/human/close
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
// POST /api/account/update-photo
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
            creditBlocked: !!opts.creditBlocked,
            source: opts.source || 'web',
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
// POST /api/account/check-exists
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

        // Also migrate email drafts/queue ownership
        for (const col of ['email_drafts', 'email_queue']) {
            const snap = await db.collection(col).where('ownerEmail', '==', oldEmail).get();
            if (snap.empty) continue;
            const batch = db.batch();
            snap.docs.forEach(d => batch.update(d.ref, { ownerEmail: newEmail }));
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
// PASSWORD RESET
// ════════════════════════════════════════════════════════════════════════════
const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

function getResend() {
    if (!process.env.RESEND_API_KEY) throw new Error('Missing RESEND_API_KEY env var.');
    return new Resend(process.env.RESEND_API_KEY);
}

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
            from: process.env.RESEND_FROM_EMAIL || 'Mebor AI <onboarding@resend.dev>',
            to: email,
            subject: 'Reset your Mebor AI password',
            html: `
                <div style="max-width: 520px; margin: 0 auto; font-family: 'Google Sans Flex', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 20px; padding: 40px 36px; box-shadow: 0 10px 25px -5px rgba(15, 23, 42, 0.05); box-sizing: border-box;">

  <div style="display: flex; align-items: center; margin-bottom: 28px;">
    <span style="margin-left: 12px; font-size: 22px; font-weight: 800; color: #0f172a; letter-spacing: -0.5px;">
      Mebor<span style="color: #5b3df5;"> AI</span>
    </span>
  </div>

  <h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 700; color: #0f172a; letter-spacing: -0.3px; line-height: 1.3;">
    Reset your password
  </h2>
  
  <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.6; color: #475569;">
    We received a request to reset the password for your Mebor AI account attached to 
    <span style="display: inline-block; background-color: #f1f5f9; color: #334155; padding: 2px 10px; border-radius: 6px; font-weight: 600; font-size: 14px; word-break: break-all;">
      ${email}
    </span>.
  </p>

  <div style="text-align: center; margin-bottom: 28px;">
    <a href="${resetLink}" target="_blank" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #5b3df5 0%, #7c3aed 100%); color: #ffffff; text-decoration: none; font-weight: 700; font-size: 15px; border-radius: 100px; box-shadow: 0 6px 20px rgba(91, 61, 245, 0.35); letter-spacing: 0.2px;">
      Reset Password &rarr;
    </a>
  </div>

  <div style="background-color: #f8fafc; border-left: 4px solid #5b3df5; border-radius: 8px; padding: 14px 16px; margin-bottom: 24px;">
    <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #64748b;">
      <strong style="color: #0f172a; font-weight: 600;">Security Note:</strong> This reset link will expire in <strong style="color: #5b3df5;">1 hour</strong>. If you did not request a password reset, no action is required and you can safely ignore this email.
    </p>
  </div>

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

async function handlePasswordResetConfirm(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return res.status(400).json({ success: false, message: 'Missing token or newPassword.' });
    if (newPassword.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });

    try {
        const db = getDb();
        const tokenRef = db.collection('password_reset_tokens').doc(token);

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
            description: `Contact: ${appt.contactInfo}\nBooked via Mebor AI`,
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
            description: `Contact: ${appt.contactInfo}\nBooked via Mebor AI`,
            start: { dateTime: localStart, timeZone },
            end:   { dateTime: localEnd,   timeZone },
        }),
    });
    if (!r.ok) {
        const d = await r.json();
        console.error('[Calendar] Update error:', d.error?.message);
    }
}
