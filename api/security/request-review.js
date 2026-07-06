import Groq from 'groq-sdk';
import { getAdmin, REASON_LABELS } from './lib.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

    try {
        const { email, reviewText } = req.body;
        if (!email || !reviewText || !reviewText.trim()) {
            return res.status(400).json({ success: false, message: 'Missing email or review text.' });
        }

        const { db } = getAdmin();
        const userRef = db.collection('users').doc(email);
        const snap = await userRef.get();
        if (!snap.exists) return res.status(404).json({ success: false, message: 'Account not found.' });

        const data = snap.data();
        if (data.accountStatus !== 'disabled') {
            return res.status(400).json({ success: false, message: 'This account is not currently disabled.' });
        }
        if (data.reviewStatus === 'pending' || data.reviewStatus === 'decided') {
            return res.status(400).json({ success: false, message: 'A review has already been submitted for this account.' });
        }

        const now = new Date();
        const revealAt = new Date(now.getTime() + 48 * 60 * 60 * 1000);

        // Ask the model to weigh the violation against the user's explanation.
        let decision = 'permanently_disabled';
        let aiReasoning = 'Unable to complete automated review; defaulting to manual escalation.';

        if (process.env.GROQ_API_KEY) {
            try {
                const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
                const reasonLabel = REASON_LABELS[data.disabledReasonCode] || data.disabledReason || 'Policy violation.';
                const completion = await groq.chat.completions.create({
                    model: 'llama-3.1-8b-instant',
                    temperature: 0.2,
                    max_tokens: 400,
                    messages: [
                        {
                            role: 'system',
                            content: `You are a trust & safety reviewer for a SaaS platform. An account was automatically disabled for: "${reasonLabel}". The user has submitted an appeal. Decide whether to reinstate the account ("enabled") or keep it permanently disabled ("permanently_disabled"). Be reasonably lenient for first-time, plausible, good-faith explanations, and strict for explanations that are evasive, dishonest-sounding, or fail to address the violation. Respond ONLY with compact JSON: {"decision": "enabled" | "permanently_disabled", "reasoning": "one or two sentence explanation"}`
                        },
                        { role: 'user', content: `User's appeal: "${reviewText.trim()}"` }
                    ]
                });
                const raw = completion.choices[0]?.message?.content || '{}';
                const cleaned = raw.replace(/```json|```/g, '').trim();
                const parsed = JSON.parse(cleaned);
                if (parsed.decision === 'enabled' || parsed.decision === 'permanently_disabled') {
                    decision = parsed.decision;
                }
                aiReasoning = parsed.reasoning || aiReasoning;
            } catch (err) {
                console.error('AI review error, defaulting to manual-safe outcome:', err);
            }
        }

        const permanentDeleteAt = decision === 'permanently_disabled'
            ? new Date(revealAt.getTime() + 12 * 60 * 60 * 1000).toISOString()
            : null;

        await userRef.set({
            reviewStatus: 'decided', // decision is computed now, but hidden from the user until revealAt
            reviewText: reviewText.trim(),
            reviewRequestedAt: now.toISOString(),
            reviewRevealAt: revealAt.toISOString(),
            reviewDecision: decision,
            reviewReasoning: aiReasoning,
            permanentDeleteAt
        }, { merge: true });

        return res.status(200).json({
            success: true,
            reviewRevealAt: revealAt.toISOString(),
            message: 'Your appeal has been submitted for review.'
        });

    } catch (error) {
        console.error('Request review error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
}
