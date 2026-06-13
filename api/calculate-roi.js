// api/calculate-roi.js
import { getAdminDb } from './firebaseAdmin.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { businessId } = req.body || {};
    if (!businessId) return res.json({ success: false, message: 'Missing businessId.' });

    try {
        const db   = getAdminDb();
        const snap = await db.collection('user_bots').doc(businessId).collection('chats').get();

        let total = 0, genuine = 0, leads = 0;
        snap.forEach(d => {
            const c = d.data();
            total++;
            const isGenuine = c.isGenuineQuery !== undefined ? c.isGenuineQuery : true;
            if (isGenuine) genuine++;
            if (c.isLeadCaptured || c.leadCaptured) leads++;
        });

        const hoursSaved     = parseFloat(((genuine * 15) / 60).toFixed(1));
        const supportSavings = genuine * ((15 / 60) * 20);
        const leadRevenue    = leads * 50;
        const netROI         = supportSavings + leadRevenue;
        const resolutionRate = genuine > 0 ? Math.round(((genuine - leads) / genuine) * 100) : 100;

        return res.json({
            success:              true,
            totalConversations:   total,
            genuineConversations: genuine,
            hoursSaved,
            moneySaved:           parseFloat(netROI.toFixed(2)),
            leadsCaptured:        leads,
            resolutionRate
        });
    } catch (err) {
        console.error('[ROI] Error:', err);
        return res.json({ success: false, message: err.message });
    }
}
