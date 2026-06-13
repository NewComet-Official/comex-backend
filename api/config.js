// api/config.js
import { getAdminDb } from './firebaseAdmin.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { businessId } = req.query;
    if (!businessId) {
        return res.status(400).json({ success: false, error: 'Missing businessId parameter.' });
    }

    try {
        const db      = getAdminDb();
        const docSnap = await db.collection('user_bots').doc(businessId).get();

        if (!docSnap.exists) {
            return res.status(404).json({ success: false, error: 'Bot configuration not found.' });
        }

        const bot = docSnap.data();
        return res.status(200).json({
            success:      true,
            name:         bot.name         || 'AI Assistant',
            position:     bot.position     || 'bottom-right',
            logoBase64:   bot.logoBase64   || null,
            designConfig: bot.designConfig || {}
        });
    } catch (err) {
        console.error('[Config] Error:', err);
        return res.status(500).json({ success: false, error: 'Internal server error.' });
    }
}
