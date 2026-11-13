// zendesk.js
import crypto from 'crypto';

const ZD_TAGS = {
    INVOLVED: 'mebor-involved',
    ROUTED: 'mebor-routed-to-workspace',
    SOFT_RESOLVED: 'mebor-soft-resolved',
    NO_AI: 'mebor-no-ai',
};

function sanitizeSubdomain(raw) {
    return String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\.zendesk\.com.*$/, '')
        .replace(/[^a-z0-9-]/g, '');
}

async function zendeskApi(subdomain, accessToken, path, { method = 'GET', body } = {}) {
    const url = `https://${subdomain}.zendesk.com/api/v2${path}`;
    const r = await fetch(url, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10000),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!r.ok) {
        throw new Error(`Zendesk ${method} ${path} failed (${r.status}): ${json?.error || json?.description || text.slice(0, 200)}`);
    }
    return json;
}

// Automatically provisions the webhook & trigger in the user's Zendesk account after OAuth
async function provisionZendeskWebhookAndTrigger(subdomain, accessToken, webhookUrl) {
    const whRes = await zendeskApi(subdomain, accessToken, '/webhooks', {
        method: 'POST',
        body: {
            webhook: {
                name: 'MeborAgents Ticket Sync',
                status: 'active',
                endpoint: webhookUrl,
                http_method: 'POST',
                request_format: 'json',
                subscriptions: ['conditional_ticket_events'],
            },
        },
    });
    const webhookId = whRes?.webhook?.id;
    const signingSecret = whRes?.webhook?.signing_secret || null;

    if (webhookId) {
        await zendeskApi(subdomain, accessToken, '/triggers', {
            method: 'POST',
            body: {
                trigger: {
                    title: 'MeborAgents — Notify AI on Customer Ticket Activity',
                    active: true,
                    conditions: {
                        all: [
                            { field: 'update_type', operator: 'is', value: 'Create' },
                        ],
                        any: [],
                    },
                    actions: [
                        {
                            field: 'notification_webhook',
                            value: [
                                webhookId,
                                JSON.stringify({
                                    ticket_id: '{{ticket.id}}',
                                    subject: '{{ticket.title}}',
                                    description: '{{ticket.latest_public_comment}}',
                                    status: '{{ticket.status}}',
                                    tags: '{{ticket.tags}}',
                                    requester_email: '{{ticket.requester.email}}',
                                    requester_name: '{{ticket.requester.name}}',
                                }),
                            ],
                        },
                    ],
                },
            },
        });
    }
    return { webhookId, signingSecret };
}

export function createZendeskHandlers(deps) {
    const {
        getDb,
        getUserSecrets,
        setUserSecrets,
        publicIntegrationFlag,
        requireAuth,
        requireOAuthStarter,
        gateOAuthFeature,
        verifyOAuthState,
        signOAuthState,
        buildAppUrl,
        parseAutoSendDelay,
        encryptCredential,
        decryptCredential,
        resolveOwnerContext,
        resolvePlanLimits,
        sendFCMToUser,
        logChat,
        generateBotReply,
        normalizeChannels,
        getPublicBaseUrl,
    } = deps;

    // 1. GET /api/oauth/zendesk?email=...&subdomain=...&origin=...&ticket=...
    async function handleZendeskOAuth(req, res) {
        const { email, subdomain: rawSub, origin } = req.query;
        const subdomain = sanitizeSubdomain(rawSub);
        if (!email || !subdomain) {
            return res.status(400).send('Missing email or valid Zendesk subdomain.');
        }

        if (!(await requireOAuthStarter(req, res, email))) return;
        if (await gateOAuthFeature(req, res, email, origin, 'zendeskAgent')) return;

        const clientId = process.env.ZENDESK_CLIENT_ID;
        const redirectUri = process.env.ZENDESK_REDIRECT_URI ||
            `https://${req.headers.host}/api/oauth/zendesk/callback`;
        if (!clientId) return res.status(500).send('Missing ZENDESK_CLIENT_ID env var.');

        const state = signOAuthState({ email, subdomain, origin: origin || null, kind: 'oauth_callback' });
        const url = new URL(`https://${subdomain}.zendesk.com/oauth/authorizations/new`);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('scope', 'read write tickets:read tickets:write webhooks:read webhooks:write triggers:read triggers:write');
        url.searchParams.set('state', state);

        return res.redirect(302, url.toString());
    }

    // 2. GET /api/oauth/zendesk/callback
    async function handleZendeskCallback(req, res) {
        const { code, state, error } = req.query;
        const parsed = verifyOAuthState(state);
        if (!parsed) return res.status(400).send('Invalid or expired state parameter.');

        const { email, subdomain, origin } = parsed;
        const appUrl = buildAppUrl(req, origin);
        const failRedirect = (msg) => {
            try {
                const u = new URL(appUrl);
                u.searchParams.set('zendesk_error', msg);
                return res.redirect(302, u.toString());
            } catch {
                return res.status(400).send(`Zendesk connection failed: ${msg}`);
            }
        };

        if (error) return failRedirect(String(error).slice(0, 150));
        if (!code) return failRedirect('missing_code');
        if (await gateOAuthFeature(req, res, email, origin, 'zendeskAgent')) return;

        const clientId = process.env.ZENDESK_CLIENT_ID;
        const clientSecret = process.env.ZENDESK_CLIENT_SECRET;
        const redirectUri = process.env.ZENDESK_REDIRECT_URI ||
            `https://${req.headers.host}/api/oauth/zendesk/callback`;

        try {
            const tokenRes = await fetch(`https://${subdomain}.zendesk.com/oauth/tokens`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    grant_type: 'authorization_code',
                    code,
                    client_id: clientId,
                    client_secret: clientSecret,
                    redirect_uri: redirectUri,
                    scope: 'read write tickets:read tickets:write webhooks:read webhooks:write triggers:read triggers:write',
                }),
            });
            const tokens = await tokenRes.json().catch(() => ({}));
            if (!tokenRes.ok || !tokens.access_token) {
                return failRedirect(tokens.error_description || tokens.error || 'token_exchange_failed');
            }

            const db = getDb();

            // Prevent two accounts from claiming the same subdomain
            const existing = await db.collection('user_secrets')
                .where('integrations.zendesk.subdomain', '==', subdomain)
                .limit(5)
                .get();
            let taken = false;
            existing.forEach(d => {
                if (d.id !== email && d.data()?.integrations?.zendesk?.connected) taken = true;
            });
            if (taken) return failRedirect('subdomain_already_connected');

            const webhookUrl = `${getPublicBaseUrl(req).replace(/\/$/, '')}/api/zendesk/webhook?subdomain=${encodeURIComponent(subdomain)}`;
            let hookMeta = { webhookId: null, signingSecret: null };
            try {
                hookMeta = await provisionZendeskWebhookAndTrigger(subdomain, tokens.access_token, webhookUrl);
            } catch (e) {
                console.warn('[Zendesk/ProvisionWebhook]', e.message);
            }

            await setUserSecrets(db, email, {
                integrations: {
                    zendesk: {
                        connected: true,
                        subdomain,
                        accountLabel: `${subdomain}.zendesk.com`,
                        accessTokenEnc: encryptCredential(tokens.access_token),
                        webhookId: hookMeta.webhookId,
                        signingSecretEnc: hookMeta.signingSecret ? encryptCredential(hookMeta.signingSecret) : null,
                        connectedAt: new Date().toISOString(),
                    },
                },
            });
            await db.collection('users').doc(email).set({
                integrations: { zendesk: publicIntegrationFlag(true) },
            }, { merge: true });

            const u = new URL(appUrl);
            u.searchParams.set('zendesk_connected', '1');
            return res.redirect(302, u.toString());
        } catch (err) {
            console.error('[Zendesk/Callback]', err.message);
            return failRedirect('server_error');
        }
    }

    // 3. Outbound Escalation Helper (Chat -> Zendesk Ticket with full transcript + tags)
    async function createZendeskEscalationTicket(db, { ownerEmail, businessId, botName, conversationId, history, latestUserMsg, customerName, customerEmail }) {
        if (!ownerEmail) return null;
        const secrets = await getUserSecrets(db, ownerEmail);
        const zd = secrets?.integrations?.zendesk;
        if (!zd?.connected || !zd.accessTokenEnc) return null;

        const accessToken = decryptCredential(zd.accessTokenEnc);
        const transcript = [...(history || []), { role: 'user', content: latestUserMsg }]
            .map(m => `${m.role === 'user' ? 'Customer' : botName}: ${m.content}`)
            .join('\n\n');

        const ticketBody = [
            `Escalated from MeborAgents (${botName})`,
            `Conversation ID: ${conversationId}`,
            '',
            '--- Conversation Transcript ---',
            transcript,
        ].join('\n');

        const payload = {
            ticket: {
                subject: `[${botName}] Support Escalation${customerName ? ` from ${customerName}` : ''}`,
                comment: { body: ticketBody, public: false },
                priority: 'normal',
                tags: [ZD_TAGS.INVOLVED, ZD_TAGS.ROUTED, ZD_TAGS.NO_AI],
                ...(customerEmail ? {
                    requester: {
                        name: customerName || customerEmail.split('@')[0],
                        email: customerEmail,
                    },
                } : {}),
            },
        };

        const created = await zendeskApi(zd.subdomain, accessToken, '/tickets.json', {
            method: 'POST',
            body: payload,
        });

        return {
            ticketId: created?.ticket?.id || null,
            url: created?.ticket?.id ? `https://${zd.subdomain}.zendesk.com/agent/tickets/${created.ticket.id}` : null,
        };
    }

    // 4. POST /api/zendesk/webhook (Inbound Ticket -> AI Draft or Auto-Reply)
    async function handleZendeskWebhook(req, res) {
        if (req.method !== 'POST') return res.status(405).json({ ok: false });

        const subdomain = sanitizeSubdomain(req.query?.subdomain || req.body?.subdomain);
        const body = req.body || {};
        const ticketId = body.ticket_id;

        if (!subdomain || !ticketId) return res.status(200).json({ ok: true });

        try {
            const db = getDb();

            // Deduplicate rapid duplicate trigger fires
            const evKey = `${subdomain}__${ticketId}__${crypto.createHash('sha1').update(String(body.description || '')).digest('hex').slice(0, 12)}`;
            try {
                await db.collection('zendesk_events').doc(evKey).create({ receivedAt: new Date().toISOString() });
            } catch {
                return res.status(200).json({ ok: true, duplicate: true });
            }

            // Look up owner
            const snap = await db.collection('user_secrets')
                .where('integrations.zendesk.subdomain', '==', subdomain)
                .limit(5)
                .get();
            let ownerEmail = null, zd = null;
            snap.forEach(d => {
                const z = d.data()?.integrations?.zendesk;
                if (z?.connected && z.accessTokenEnc && !ownerEmail) {
                    ownerEmail = d.id;
                    zd = z;
                }
            });
            if (!ownerEmail || !zd) return res.status(200).json({ ok: true });

            // Check tag state machine: never reply if human override or already routed
            const rawTags = String(body.tags || '').toLowerCase().split(/\s+/).filter(Boolean);
            if (rawTags.includes(ZD_TAGS.NO_AI) || rawTags.includes(ZD_TAGS.ROUTED)) {
                return res.status(200).json({ ok: true, skipped: 'human-owned' });
            }

            const ctx = await resolveOwnerContext(db, ownerEmail);
            const limits = resolvePlanLimits(ctx.ownerProfile);
            if (!limits.features.zendeskAgent) return res.status(200).json({ ok: true });

            // Find the user's Zendesk-enabled agent
            let agent = null;
            const botsSnap = await db.collection('user_bots').where('owner', '==', ownerEmail).get();
            botsSnap.forEach(d => {
                const b = d.data();
                if (b.deletedAt || agent) return;
                if (normalizeChannels(b).includes('zendesk')) {
                    agent = { id: d.id, name: b.displayName || b.name || 'Support Assistant', data: b };
                }
            });
            if (!agent) return res.status(200).json({ ok: true });

            const userQuery = `${body.subject ? `Subject: ${body.subject}\n\n` : ''}${body.description || ''}`.trim();
            if (!userQuery) return res.status(200).json({ ok: true });

            const zdConfig = agent.data.zendeskConfig || {};
            const extraInstructions = zdConfig.instructions
                ? `\n\n[ZENDESK TICKET INSTRUCTIONS]:\n${zdConfig.instructions}`
                : '';

            const result = await generateBotReply({
                db,
                businessId: agent.id,
                userMsg: userQuery + extraInstructions,
                history: [],
                conversationId: `zd-${subdomain}-${ticketId}`,
                source: 'email', // uses rich structured support reply formatting
            });

            const replyText = result?.answer || "Thank you for reaching out. A support specialist will review your ticket shortly.";
            const nowISO = new Date().toISOString();
            const requireApproval = zdConfig.requireHumanApproval !== false;
            const accessToken = decryptCredential(zd.accessTokenEnc);

            const draftBase = {
                ownerEmail,
                businessId: agent.id,
                botName: agent.name,
                subdomain,
                ticketId: String(ticketId),
                subject: body.subject || `Ticket #${ticketId}`,
                requesterEmail: body.requester_email || '',
                requesterName: body.requester_name || 'Customer',
                originalMessage: userQuery,
                draftedResponse: replyText,
                createdAt: nowISO,
            };

            if (requireApproval) {
                const ref = await db.collection('zendesk_drafts').add({ ...draftBase, status: 'pending' });
                sendFCMToUser(ownerEmail, {
                    title: `🎫 New Zendesk draft (#${ticketId})`,
                    body: replyText.slice(0, 120),
                    url: '/zendesk-dashboard',
                    tag: `zd-approval-${ref.id}`,
                    type: 'zendesk_approval',
                }).catch(() => {});
                return res.status(200).json({ ok: true });
            }

            // Autonomous Mode: post public reply & apply state machine tags
            const nextTags = [...new Set([...rawTags, ZD_TAGS.INVOLVED, ZD_TAGS.SOFT_RESOLVED])];
            await zendeskApi(subdomain, accessToken, `/tickets/${encodeURIComponent(ticketId)}.json`, {
                method: 'PUT',
                body: {
                    ticket: {
                        comment: { body: replyText, public: true },
                        tags: nextTags,
                    },
                },
            });

            await db.collection('zendesk_drafts').add({ ...draftBase, status: 'sent', sentAt: nowISO, autoSent: true });
            await logChat(db, agent.id, `zd-${subdomain}-${ticketId}`, userQuery, replyText, true, false, { source: 'zendesk' });
            return res.status(200).json({ ok: true });
        } catch (err) {
