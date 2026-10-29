// googleChat.js — full file

// ─────────────────────────────────────────────────────────────
// CORS / preflight helpers
// ─────────────────────────────────────────────────────────────
function _gchatCorsHeaders(origin) {
    return {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
    };
}

function _gchatApplyCors(req, res) {
    const headers = _gchatCorsHeaders(req.headers?.origin);
    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
}

// ─────────────────────────────────────────────────────────────
// OPTIONS (preflight) — must be registered for /status and /pending
// ─────────────────────────────────────────────────────────────
async function handleGoogleChatOptions(req, res) {
    _gchatApplyCors(req, res);
    return res.status(204).end();
}

// ─────────────────────────────────────────────────────────────
// GET /api/google-chat/status?ownerEmail=…[&stats=1]
// ─────────────────────────────────────────────────────────────
async function handleGoogleChatStatus(req, res) {
    _gchatApplyCors(req, res);

    if (req.method !== 'GET') {
        return res.status(405).json({ success: false, message: 'Method not allowed' });
    }

    const ownerEmail = String(req.query?.ownerEmail || '').trim();
    if (!ownerEmail) {
        return res.status(400).json({ success: false, connected: false, message: 'ownerEmail is required' });
    }

    try {
        const db = getDb();

        // Read the authoritative connection record from user_secrets (same place
        // the OAuth callback writes it). Fall back to the public `users` doc.
        let gc = null;
        try {
            const secretsSnap = await db.collection('user_secrets').doc(ownerEmail).get();
            if (secretsSnap.exists) gc = secretsSnap.data()?.integrations?.google_chat || null;
        } catch (e) {
            console.warn('[GoogleChat/Status/secrets]', e.message);
        }

        if (!gc) {
            try {
                const userSnap = await db.collection('users').doc(ownerEmail).get();
                if (userSnap.exists) gc = userSnap.data()?.integrations?.google_chat || null;
            } catch (e) {
                console.warn('[GoogleChat/Status/users]', e.message);
            }
        }

        const connected = !!gc?.connected;

        let stats = null;
        if (connected && String(req.query?.stats) === '1') {
            stats = {};
            try {
                const botsSnap = await db.collection('user_bots').where('owner', '==', ownerEmail).get();
                const gchatBotIds = new Set();

                botsSnap.forEach(d => {
                    const b = d.data();
                    if (b.deletedAt) return;
                    if (!normalizeChannels(b).includes('googlechat')) return;
                    gchatBotIds.add(d.id);
                    stats[d.id] = { pending: 0, sent: 0 };
                });

                if (gchatBotIds.size) {
                    // Pending drafts
                    try {
                        const pendSnap = await db.collection('google_chat_drafts')
                            .where('ownerEmail', '==', ownerEmail)
                            .get();
                        pendSnap.forEach(d => {
                            const v = d.data();
                            if (!stats[v.businessId]) stats[v.businessId] = { pending: 0, sent: 0 };
                            if (v.status === 'pending') stats[v.businessId].pending++;
                            if (v.status === 'sent' || v.status === 'scheduled') stats[v.businessId].sent++;
                        });
                    } catch (e) {
                        console.warn('[GoogleChat/Status/drafts]', e.message);
                    }
                }
            } catch (e) {
                console.warn('[GoogleChat/Status/bots]', e.message);
            }
        }

        return res.status(200).json({
            success: true,
            connected,
            accountLabel: gc?.accountLabel || gc?.email || null,
            spaceName: gc?.space_name || null,
            stats,
        });
    } catch (e) {
        console.error('[GoogleChat/Status]', e.message);
        // Non-fatal: return a well-shaped payload so the client doesn't turn this into "Network Error"
        return res.status(200).json({ success: true, connected: false, stats: {} });
    }
}

// ─────────────────────────────────────────────────────────────
// GET /api/google-chat/pending?ownerEmail=…
// ─────────────────────────────────────────────────────────────
async function handleGoogleChatPending(req, res) {
    _gchatApplyCors(req, res);

    if (req.method !== 'GET') {
        return res.status(405).json({ success: false, pending: [] });
    }

    const ownerEmail = String(req.query?.ownerEmail || '').trim();
    if (!ownerEmail) {
        return res.status(400).json({ success: false, pending: [], message: 'ownerEmail is required' });
    }

    try {
        const db = getDb();
        const snap = await db.collection('google_chat_drafts')
            .where('ownerEmail', '==', ownerEmail)
            .where('status', '==', 'pending')
            .get();

        const pending = [];
        snap.forEach(d => {
            const v = d.data();
            pending.push({
                id: d.id,
                businessId: v.businessId || '',
                botName: v.botName || v.businessId || 'Google Chat Agent',
                spaceName: v.spaceName || '',
                originalMessage: v.originalMessage || '',
                draftedResponse: v.draftedResponse || '',
                createdAt: v.createdAt || null,
            });
        });

        // Newest first — matches what the dashboard renders
        pending.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

        return res.status(200).json({ success: true, pending });
    } catch (e) {
        console.error('[GoogleChat/Pending]', e.message);
        // Non-fatal: empty list rather than a hard failure
        return res.status(200).json({ success: true, pending: [] });
    }
}

// ─────────────────────────────────────────────────────────────
// POST /api/google-chat/webhook  (UNCHANGED)
// ─────────────────────────────────────────────────────────────
async function handleGoogleChatWebhook(req, res) {
        if (req.method !== 'POST') return res.status(405).json({});
        if (!(await verifyGoogleChatRequest(req))) return res.status(401).json({ text: 'Unauthorized.' });

        const raw = req.body || {};
        const chatPayload = raw.chat?.messagePayload || raw;
        const eventType = raw.type || (raw.chat?.addedToSpacePayload ? 'ADDED_TO_SPACE' : (raw.chat?.messagePayload ? 'MESSAGE' : null));

        if (eventType === 'ADDED_TO_SPACE') {
            return res.json({ text: 'Thanks for adding me! Ask me anything about this business.' });
        }

        const msgObj = chatPayload.message || raw.message;
        const spaceObj = chatPayload.space || raw.space || raw.chat?.addedToSpacePayload?.space;
        const spaceName = spaceObj?.name;
        const userText = String(msgObj?.argumentText || msgObj?.text || '').trim();

        if (eventType !== 'MESSAGE' || !spaceName || !userText) return res.json({});

        const db = getDb();
        let ownerEmail = null;

        try {
            const secretsSnap = await db.collection('user_secrets').get();
            const candidates = [];

            secretsSnap.forEach(d => {
                const gc = d.data()?.integrations?.google_chat;
                if (!gc?.connected) return;
                if (gc.space_name === spaceName) {
                    ownerEmail = d.id;
                } else if (!gc.space_name) {
                    candidates.push({ email: d.id, connectedAt: gc.connectedAt || '' });
                }
            });

            if (!ownerEmail && candidates.length) {
                candidates.sort((a, b) => (b.connectedAt || '').localeCompare(a.connectedAt || ''));
                ownerEmail = candidates[0].email;
                await setUserSecrets(db, ownerEmail, {
                    integrations: { google_chat: { space_name: spaceName } },
                });
                await db.collection('users').doc(ownerEmail).set({
                    integrations: { google_chat: { connected: true, space_name: spaceName } },
                }, { merge: true });
            }
        } catch (e) {
            console.warn('[GoogleChat/Webhook/lookup]', e.message);
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

            await runGoogleChatReplyJob(db, Date.now());
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
            const schedSnap = await db.collection('google_chat_drafts')
                .where('status', '==', 'scheduled')
                .get();
            const dueDocs = schedSnap.docs
                .filter(d => (d.data().scheduledAt || '') <= nowISO)
                .slice(0, 5);

            for (const d of dueDocs) {
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

        let pendingDocs = [];
        try {
            const pendingSnap = await db.collection('google_chat_queue')
                .where('status', '==', 'pending')
                .get();
            pendingDocs = pendingSnap.docs
                .sort((a, b) => String(a.data().createdAt || '').localeCompare(String(b.data().createdAt || '')))
                .slice(0, 5);
        } catch (e) {
            console.error('[GoogleChat/QueueQuery]', e.message);
            return result;
        }

        for (const q of pendingDocs) {
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

// ─────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────
module.exports = {
    handleGoogleChatWebhook,
    handleGoogleChatStatus,
    handleGoogleChatPending,
    handleGoogleChatOptions,
};
