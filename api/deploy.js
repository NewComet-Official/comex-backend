import { getAdminDb } from './firebaseAdmin.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

    try {
        const { botData, ownerEmail } = req.body;

        if (!botData || !ownerEmail) {
            return res.status(400).json({ success: false, message: 'Missing botData or ownerEmail.' });
        }
        if (!botData.id || !botData.name) {
            return res.status(400).json({ success: false, message: 'botData must have id and name.' });
        }

        // Ensure owner matches what was sent (basic server-side validation)
        botData.owner = ownerEmail;
        botData.createdAt = botData.createdAt || new Date().toISOString();
        botData.deletedAt = null;

        const db = getAdminDb();
        await db.collection('user_bots').doc(botData.id).set(botData, { merge: true });

        console.log('[Deploy] Bot saved:', botData.id, 'for', ownerEmail);
        return res.status(200).json({ success: true, botId: botData.id });

    } catch (err) {
        console.error('[Deploy] Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
}
