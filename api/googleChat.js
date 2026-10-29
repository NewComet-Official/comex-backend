// googleChat.js — Google Chat (user-auth) for Mebor.
// Imported by index.js. All functions here are also re-exported from that handler.
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';

const GOOGLE_CHAT_API = 'https://chat.googleapis.com/v1';
const GOOGLE_CHAT_ISSUER = 'chat@system.gserviceaccount.com';

export function createGoogleChatHandlers({
    admin, getDb, getUserSecrets, setUserSecrets, publicIntegrationFlag,
    requireAuth, requireOAuthStarter, gateOAuthFeature, verifyOAuthState,
    signOAuthState, buildAppUrl, parseAutoSendDelay, CREDIT_COSTS,
    resolveOwnerContext, resolvePlanLimits, consumeCredits,
    refreshGenericGoogleToken, sendFCMToUser, logChat,
    generateBotReply, normalizeChannels,
}) {
    async function handleGoogleChatOAuth(req, res) {
        const { email, origin } = req.query;
        if (!email) return res.status(400).send('Missing email.');
        if (!(await requireOAuthStarter(req, res, email))) return;
        if (await gateOAuthFeature(req, res, email, origin, 'googleChatAgent')) return;

        const clientId    = process.env.GOOGLE_CLIENT_ID_CHAT;
        const redirectUri = process.env.GOOGLE_CHAT_REDIRECT_URI ||
                            `https://${req.headers.host}/api/oauth/google-chat/callback`;
        if (!clientId) return res.status(500).send('Missing GOOGLE_CLIENT_ID_CHAT env var.');

        const state = signOAuthState({ email, origin: origin || null, kind: 'oauth_callback' });
        const url   = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.searchParams.set('client_id',     clientId);
        url.searchParams.set('redirect_uri',  redirectUri);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('scope', [
            'openid', 'email',
            'https://www.googleapis.com/auth/chat.messages.create',
            'https://www.googleapis.com/auth/chat.spaces.readonly',
        ].join(' '));
        url.searchParams.set('access_type',   'offline');
        url.searchParams.set('prompt',        'consent');
        url.searchParams.set('state',         state);
        return res.redirect(302, url.toString());
    }

    async function handleGoogleChatCallback(req, res) {
        const { code, state, error } = req.query;
        if (error) return res.status(400).send(`OAuth error: ${error}`);
        if (!code || !state) return res.status(400).send('Missing code or state.');

        const parsed = verifyOAuthState(state);
        if (!parsed) return res.status(400).send('Invalid state parameter.');
        const { email, origin } = parsed;
        if (await gateOAuthFeature(req, res, email, origin, 'googleChatAgent')) return;

        const clientId     = process.env.GOOGLE_CLIENT_ID_CHAT;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET_CHAT;
        const redirectUri  = process.env.GOOGLE_CHAT_REDIRECT_URI ||
                             `https://${req.headers.host}/api/oauth/google-chat/callback`;
        if (!clientId || !clientSecret) return res.status(500).send('Missing Google Chat OAuth env vars.');

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
            await setUserSecrets(db, email, {
                integrations: {
                    google_chat: {
                        connected:     true,
                        accountLabel,
                        access_token:  tokens.access_token,
                        refresh_token: tokens.refresh_token || null,
                        expiry_date:   tokens.expires_in
                            ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
                            : new Date(Date.now() + 3600 * 1000).toISOString(),
                        connectedAt: new Date().toISOString(),
                        space_name:  null,
                    },
                },
            });
            await db.collection('users').doc(email).set({
                integrations: { google_chat: publicIntegrationFlag(true) },
            }, { merge: true });

            const appUrl = buildAppUrl(req, origin);
            return res.redirect(302, `${appUrl}?google_chat_connected=1`);
        } catch (err) {
            console.error('[OAuth/GoogleChat]', err.message);
            return res.status(500).send(`Server error: ${err.message}`);
        }
    }

    async function verifyGoogleChatRequest(req) {
        const authHeader = req.headers.authorization || '';
        if (!authHeader.startsWith('Bearer ')) return false;
        const idToken = authHeader.substring(7);
        const audience = process.env.GOOGLE_CHAT_WEBHOOK_AUDIENCE ||
                         `https://${req.headers.host}/api/google-chat/webhook`;
        try {
            const client = new OAuth2Client();
            const ticket = await client.verifyIdToken({ idToken, audience });
            const payload = ticket.getPayload();
            return payload?.email_verified === true && payload?.email === GOOGLE_CHAT_ISSUER;
        } catch (e) {
            console.warn('[GoogleChat/Verify]', e.message);
            return false;
        }
    }

    async function sendGoogleChatMessageAsUser(ownerEmail, spaceName, text) {
        const db = getDb();
        const secrets = await getUserSecrets(db, ownerEmail);
        const gc = secrets?.integrations?.google_chat;
        if (!gc?.connected) throw new Error('Google Chat not connected for this user.');
        if (!spaceName) throw new Error('No Google Chat space bound to this user yet.');

        const accessToken = await refreshGenericGoogleToken(gc, ownerEmail, db, 'google_chat');

        const r = await fetch(`${GOOGLE_CHAT_API}/${spaceName}/messages`, {
            method:  'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body:    JSON.stringify({ text: String(text || '').substring(0, 4000) }),
        });
        if (!r.ok) {
            const errText = await r.text();
            throw new Error(`Google Chat send failed (HTTP ${r.status}): ${errText.substring(0, 300)}`);
        }
        return r.json();
    }

    async function handleGoogleChatWebhook(req, res) {
        if (req.method !== 'POST') return res.status(405).json({});
        if (!(await verifyGoogleChatRequest(req))) return res.status(401).json({ text: 'Unauthorized.' });

        const event = req.body || {};
        if (event.type === 'ADDED_TO_SPACE') {
            return res.json({ text: 'Thanks for adding me! Ask me anything about this business.' });
        }
        if (event.type !== 'MESSAGE' || !event.message?.text) return res.json({});

        const spaceName = event.space?.name;
        const userText  = String(event.message.text || '').trim();
        if (!spaceName || !userText) return res.json({});

        const db = getDb();
        let ownerEmail = null;
        try {
            const usersSnap = await db.collection('users').get();
            usersSnap.forEach(d => {
                const gc = d.data()?.integrations?.google_chat;
                if (gc?.connected && gc?.space_name === spaceName) ownerEmail = d.id;
            });
        } catch (e) { console.warn('[GoogleChat/Webhook/lookup]', e.message); }

        if (!ownerEmail) {
            try {
                const usersSnap = await db.collection('users').get();
                const candidates = [];
                usersSnap.forEach(d => {
                    const gc = d.data()?.integrations?.google_chat;
                    if (gc?.connected && !gc?.space_name) {
                        candidates.push({ email: d.id, connectedAt: gc.connectedAt || '' });
                    }
                });
                candidates.sort((a, b) => (b.connectedAt || '').localeCompare(a.connectedAt || ''));
                if (candidates.length) {
                    ownerEmail = candidates[0].email;
                    await setUserSecrets(db, ownerEmail, {
                        integrations: { google_chat: { space_name: spaceName } },
                    });
                }
            } catch (e) { console.warn('[GoogleChat/Webhook/bind]', e.message); }
        }

        if (!ownerEmail) {
            return res.json({ text: "I'm not connected to a Mebor account yet. Please finish connecting Google Chat from your Mebor dashboard." });
        }

        let agent = null;
        try {
            const botsSnap = await db.collection('user_bots').where('owner', '==', ownerEmail).get();
            botsSnap.forEach(d => {
                const b = d.data();
                if (b.deletedAt) return;
                if (normalizeChannels(b).includes('googlechat') && !agent) {
                    agent = { id: d.id, name: b.displayName || b.name || 'Assistant' };
                }
            });
        } catch (e) { console.warn('[GoogleChat/Webhook/agent]', e.message); }

        if (!agent) {
            return res.json({ text: "No agent is configured for Google Chat yet. Turn on the Google Chat channel for one of your agents in Mebor." });
        }

        const queueId = `${ownerEmail}__${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        try {
            await db.collection('google_chat_queue').doc(queueId).set({
                ownerEmail, businessId: agent.id, botName: agent.name,
                spaceName, userMessage: userText,
                status: 'pending', createdAt: new Date().toISOString(),
            });
        } catch (e) {
            console.error('[GoogleChat/Webhook/enqueue]', e.message);
            return res.json({ text: 'Something went wrong. Please try again.' });
        }
        return res.json({ text: '_…_' });
    }

    async function runGoogleChatReplyJob(db, startedAt) {
        const result = { processed: 0, results: [] };

        try {
            const nowISO = new Date().toISOString();
            const dueSnap = await db.collection('google_chat_drafts')
                .where('status', '==', 'scheduled')
                .where('scheduledAt', '<=', nowISO)
                .limit(5).get();
            for (const d of dueSnap.docs) {
                try {
                    const draft = d.data();
                    await sendGoogleChatMessageAsUser(draft.ownerEmail, draft.spaceName, draft.draftedResponse);
                    await d.ref.set({ status: 'sent', sentAt: new Date().toISOString(), autoSent: true }, { merge: true });
                    await logChat(db, draft.businessId, `gchat-${draft.spaceName}`, draft.originalMessage || '', draft.draftedResponse, true, false, { source: 'googlechat' });
                    result.processed++;
                } catch (e) {
                    console.error('[GoogleChat/ScheduledSend]', d.id, e.message);
                    await d.ref.set({ status: 'failed', error: e.message, failedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
                }
            }
        } catch (e) { console.warn('[GoogleChat/ScheduledScan]', e.message); }

        let pendingSnap;
        try {
            pendingSnap = await db.collection('google_chat_queue')
                .where('status', '==', 'pending')
                .orderBy('createdAt', 'asc')
                .limit(5).get();
        } catch (e) { return result; }

        for (const q of pendingSnap.docs) {
            if (Date.now() - startedAt > 40000) break;
            const item = q.data();

            const ok = await db.runTransaction(async (tx) => {
                const s = await tx.get(q.ref);
                if (!s.exists || s.data().status !== 'pending') return false;
                tx.set(q.ref, { status: 'processing', processingStartedAt: new Date().toISOString() }, { merge: true });
                return true;
            }).catch(() => false);
            if (!ok) continue;

            try {
                const botSnap = await db.collection('user_bots').doc(item.businessId).get();
                if (!botSnap.exists) { await q.ref.set({ status: 'failed', error: 'agent-not-found' }, { merge: true }); continue; }
                const bot = botSnap.data();

                const ctx = await resolveOwnerContext(db, item.ownerEmail);
                const limits = resolvePlanLimits(ctx.ownerProfile);
                if (!limits.features.googleChatAgent) {
                    await q.ref.set({ status: 'skipped', reason: 'plan-lost-google-chat-feature' }, { merge: true });
                    continue;
                }

                const credit = await consumeCredits(db, item.ownerEmail, CREDIT_COSTS.message);
                if (!credit.allowed) {
                    await q.ref.set({ status: 'skipped', reason: 'no-credits' }, { merge: true });
                    continue;
                }

                const resultGen = await generateBotReply({
                    db, businessId: item.businessId, userMsg: item.userMessage,
                    history: [], conversationId: `gchat-${item.spaceName}`, source: 'googlechat',
                });
                const replyText = resultGen?.answer || 'Thanks for your message.';
                const nowISO = new Date().toISOString();

                const gcConfig = bot.googleChatConfig || {};
                const requireApproval = gcConfig.requireHumanApproval !== false;
                const delayStr = gcConfig.autoSendDelay || '00:00:02';

                if (requireApproval) {
                    const draftRef = await db.collection('google_chat_drafts').add({
                        ownerEmail: item.ownerEmail, businessId: item.businessId,
                        botName: item.botName || bot.displayName || bot.name || 'Google Chat Agent',
                        spaceName: item.spaceName,
                        originalMessage: item.userMessage,
                        draftedResponse: replyText,
                        status: 'pending', queueId: q.id, createdAt: nowISO,
                    });
                    try {
                        await sendFCMToUser(item.ownerEmail, buildGoogleChatApprovalNotification({
                            id: draftRef.id, spaceName: item.spaceName,
                            userMessage: item.userMessage,
                            botName: item.botName || bot.name || 'Google Chat Agent',
                        }), 'push');
                    } catch (e) { console.error('[GoogleChat/ApprovalFCM]', e.message); }
                    await q.ref.set({ status: 'awaiting-approval', draftId: draftRef.id, approvalRequestedAt: nowISO }, { merge: true });
                } else {
                    const delayMs = parseAutoSendDelay(delayStr);
                    if (delayMs <= 0) {
                        try {
                            await sendGoogleChatMessageAsUser(item.ownerEmail, item.spaceName, replyText);
                            await q.ref.set({ status: 'done', replyText, processedAt: nowISO }, { merge: true });
                            await logChat(db, item.businessId, `gchat-${item.spaceName}`, item.userMessage, replyText, true, false, { source: 'googlechat' });
                        } catch (sendErr) {
                            await q.ref.set({ status: 'failed', error: sendErr.message, failedAt: nowISO }, { merge: true });
                        }
                    } else {
                        const scheduledAt = new Date(Date.now() + delayMs).toISOString();
                        const draftRef = await db.collection('google_chat_drafts').add({
                            ownerEmail: item.ownerEmail, businessId: item.businessId,
                            botName: item.botName || bot.displayName || bot.name || 'Google Chat Agent',
                            spaceName: item.spaceName,
                            originalMessage: item.userMessage,
                            draftedResponse: replyText,
                            status: 'scheduled', scheduledAt,
                            queueId: q.id, createdAt: nowISO,
                        });
                        await q.ref.set({ status: 'scheduled', draftId: draftRef.id, scheduledAt }, { merge: true });
                    }
                }
                result.processed++;
            } catch (e) {
                console.error('[GoogleChat/Queue/process]', q.id, e.message);
                await q.ref.set({ status: 'failed', error: e.message }, { merge: true }).catch(() => {});
            }
        }
        return result;
    }

    async function handleGoogleChatPending(req, res) {
        const { ownerEmail } = req.query;
        if (!ownerEmail) return res.status(400).json({ success: false, message: 'Missing ownerEmail.' });
        const auth = await requireAuth(req, res, { matches: [ownerEmail] });
        if (!auth) return;
        try {
            const db = getDb();
            const snap = await db.collection('google_chat_drafts')
                .where('ownerEmail', '==', ownerEmail).where('status', '==', 'pending').get();
            const pending = [];
            snap.forEach(d => pending.push({ id: d.id, ...d.data() }));
            pending.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
            return res.json({ success: true, pending });
        } catch (e) {
            console.error('[GoogleChat/Pending]', e.message);
            return res.status(500).json({ success: false, message: e.message });
        }
    }

    async function handleGoogleChatApprove(req, res) {
        if (req.method !== 'POST') return res.status(405).json({ success: false });
        const { draftId, ownerEmail, finalResponse } = req.body || {};
        if (!draftId || !ownerEmail || !finalResponse) return res.status(400).json({ success: false, message: 'Missing draftId, ownerEmail, or finalResponse.' });
        const auth = await requireAuth(req, res, { matches: [ownerEmail] });
        if (!auth) return;
        try {
            const db = getDb();
            const draftRef = db.collection('google_chat_drafts').doc(draftId);
            const snap = await draftRef.get();
            if (!snap.exists) return res.status(404).json({ success: false, message: 'Draft not found.' });
            const draft = snap.data();
            if (draft.ownerEmail !== ownerEmail) return res.status(403).json({ success: false, message: 'You do not own this draft.' });
            if (draft.status !== 'pending') return res.status(409).json({ success: false, message: `This draft is already ${draft.status}.` });

            await sendGoogleChatMessageAsUser(ownerEmail, draft.spaceName, finalResponse);
            const now = new Date().toISOString();
            await draftRef.set({ status: 'sent', finalResponse, approvedAt: now, sentAt: now, approvedBy: ownerEmail }, { merge: true });
            if (draft.queueId) {
                try {
                    await db.collection('google_chat_queue').doc(draft.queueId).set({
                        status: 'done', replyText: finalResponse, processedAt: now, approvedBy: ownerEmail,
                    }, { merge: true });
                } catch {}
            }
            await logChat(db, draft.businessId, `gchat-${draft.spaceName}`, draft.originalMessage || '', finalResponse, true, false, { source: 'googlechat' });
            return res.json({ success: true, message: 'Reply approved and sent.' });
        } catch (e) {
            console.error('[GoogleChat/Approve]', e.message);
            try {
                await getDb().collection('google_chat_drafts').doc(draftId).set({
                    status: 'failed', error: e.message, failedAt: new Date().toISOString(),
                }, { merge: true });
            } catch {}
            return res.status(500).json({ success: false, message: e.message });
        }
    }

    async function handleGoogleChatReject(req, res) {
        if (req.method !== 'POST') return res.status(405).json({ success: false });
        const { draftId, ownerEmail } = req.body || {};
        if (!draftId || !ownerEmail) return res.status(400).json({ success: false, message: 'Missing draftId or ownerEmail.' });
        const auth = await requireAuth(req, res, { matches: [ownerEmail] });
        if (!auth) return;
        try {
            const db = getDb();
            const draftRef = db.collection('google_chat_drafts').doc(draftId);
            const snap = await draftRef.get();
            if (!snap.exists) return res.status(404).json({ success: false, message: 'Draft not found.' });
            const draft = snap.data();
            if (draft.ownerEmail !== ownerEmail) return res.status(403).json({ success: false, message: 'You do not own this draft.' });
            if (draft.status !== 'pending') return res.status(409).json({ success: false, message: `This draft is already ${draft.status}.` });
            const now = new Date().toISOString();
            await draftRef.set({ status: 'rejected', rejectedAt: now, rejectedBy: ownerEmail }, { merge: true });
            if (draft.queueId) {
                try { await db.collection('google_chat_queue').doc(draft.queueId).set({ status: 'rejected', rejectedAt: now }, { merge: true }); } catch {}
            }
            return res.json({ success: true });
        } catch (e) {
            console.error('[GoogleChat/Reject]', e.message);
            return res.status(500).json({ success: false, message: e.message });
        }
    }

    async function handleGoogleChatStatus(req, res) {
        const { ownerEmail } = req.query;
        if (!ownerEmail) return res.status(400).json({ success: false, message: 'Missing ownerEmail.' });
        const auth = await requireAuth(req, res, { matches: [ownerEmail] });
        if (!auth) return;
        try {
            const secrets = await getUserSecrets(getDb(), ownerEmail);
            const gc = secrets?.integrations?.google_chat;
            if (!gc?.connected) return res.json({ success: true, connected: false });
            return res.json({
                success: true, connected: true,
                accountLabel: gc.accountLabel || ownerEmail,
                space_name: gc.space_name || null,
                connectedAt: gc.connectedAt || null,
            });
        } catch (e) {
            console.error('[GoogleChat/Status]', e.message);
            return res.status(500).json({ success: false, message: e.message });
        }
    }

    async function handleGoogleChatDisconnect(req, res) {
        if (req.method !== 'POST') return res.status(405).json({ success: false });
        const { ownerEmail } = req.body || {};
        if (!ownerEmail) return res.status(400).json({ success: false, message: 'Missing ownerEmail.' });
        const auth = await requireAuth(req, res, { matches: [ownerEmail] });
        if (!auth) return;
        try {
            const db = getDb();
            await setUserSecrets(db, ownerEmail, { integrations: { google_chat: null } });
            await db.collection('users').doc(ownerEmail).set({ integrations: { google_chat: publicIntegrationFlag(false) } }, { merge: true });
            try {
                const draftsSnap = await db.collection('google_chat_drafts')
                    .where('ownerEmail', '==', ownerEmail)
                    .where('status', 'in', ['pending', 'scheduled']).get();
                const batch = db.batch();
                draftsSnap.docs.forEach(d => batch.update(d.ref, { status: 'abandoned', abandonedAt: new Date().toISOString() }));
                if (!draftsSnap.empty) await batch.commit();
            } catch (e) { console.warn('[GoogleChat/Disconnect/Drafts]', e.message); }
            return res.json({ success: true, message: 'Google Chat disconnected.' });
        } catch (e) {
            console.error('[GoogleChat/Disconnect]', e.message);
            return res.status(500).json({ success: false, message: e.message });
        }
    }

    function buildGoogleChatApprovalNotification(draft) {
        const preview = String(draft.userMessage || '').replace(/\s+/g, ' ').trim().substring(0, 110);
        return {
            title: '💬 New Google Chat draft',
            body:  `${preview}${preview.length >= 110 ? '…' : ''} — open your dashboard to approve or edit.`,
            url:   '/google-chat-dashboard',
            tag:   `google-chat-approval-${draft.id || Date.now()}`,
            type:  'google_chat_approval',
        };
    }

    return {
        handleGoogleChatOAuth, handleGoogleChatCallback, handleGoogleChatWebhook,
        handleGoogleChatPending, handleGoogleChatApprove, handleGoogleChatReject,
        handleGoogleChatStatus, handleGoogleChatDisconnect,
        runGoogleChatReplyJob, sendGoogleChatMessageAsUser,
    };
}
