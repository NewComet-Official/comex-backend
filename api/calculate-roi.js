import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

// Move regex outside, but keep ALL database logic inside the handler
const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const phoneRegex = /(\+?\d{1,4}[\s-])?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/;

export default async function handler(req, res) {
    // 1. FORCE HEADERS INSTANTLY - NO CODE RUNS BEFORE THIS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    // 2. INTERCEPT PREFLIGHT BROWSER CHECKS
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    try {
        // 3. INITIALIZE FIREBASE SAFELY INSIDE THE TRY/CATCH
        if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
            throw new Error('Vercel Environment Error: FIREBASE_SERVICE_ACCOUNT_KEY is missing.');
        }

        if (!getApps().length) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
            initializeApp({ credential: cert(serviceAccount) });
        }
        
        const db = getFirestore();
        const { businessId, hourlySupportCost = 20, leadValue = 50 } = req.body;

        if (!businessId) {
            return res.status(400).json({ success: false, message: 'Missing businessId parameter.' });
        }

        // 4. EXECUTE CALCULATIONS
        const chatsSnapshot = await db.collection('user_bots')
                                      .doc(businessId)
                                      .collection('chats')
                                      .get();

        let totalChats = chatsSnapshot.size;
        let resolvedByAI = 0;
        let totalLeadsCaptured = 0;
        let totalMessagesProcessed = 0;

        if (totalChats === 0) {
            return res.status(200).json({
                success: true,
                metrics: { totalConversations: 0, resolutionRate: 0, estimatedHoursSaved: 0, financialSavings: 0, pipelineValue: 0, netROI: 0 }
            });
        }

        chatsSnapshot.forEach(doc => {
            const chatData = doc.data();
            const messages = chatData.messages || [];
            totalMessagesProcessed += messages.length;

            let containsLeadInfo = false;
            let escalatedToHuman = false;

            messages.forEach(msg => {
                if (msg.sender === 'user') {
                    if (emailRegex.test(msg.text) || phoneRegex.test(msg.text)) {
                        containsLeadInfo = true;
                    }
                }
                if (chatData.isEscalated || (msg.text && msg.text.toLowerCase().includes('transferring to a human'))) {
                    escalatedToHuman = true;
                }
            });

            if (containsLeadInfo) totalLeadsCaptured++;
            if (!escalatedToHuman) resolvedByAI++;
        });

        // Calculations
        const resolutionRate = parseFloat(((resolvedByAI / totalChats) * 100).toFixed(1));
        const hoursSaved = (totalMessagesProcessed * 1.5) / 60;
        const totalCostSaved = parseFloat((hoursSaved * hourlySupportCost).toFixed(2));
        const leadValueGenerated = totalLeadsCaptured * leadValue;
        const totalROIEarned = totalCostSaved + leadValueGenerated;

        const metricsPayload = {
            totalConversations: totalChats,
            resolutionRate: resolutionRate,
            leadsCaptured: totalLeadsCaptured,
            estimatedHoursSaved: parseFloat(hoursSaved.toFixed(1)),
            financialSavings: totalCostSaved,
            pipelineValue: leadValueGenerated,
            netROI: totalROIEarned,
            lastCalculated: Timestamp.now()
        };

        // Cache snapshot
        await db.collection('user_bots')
                .doc(businessId)
                .collection('analytics')
                .doc('roi_dashboard')
                .set(metricsPayload, { merge: true });

        return res.status(200).json({ success: true, metrics: metricsPayload });

    } catch (error) {
        console.error("Backend Error Caught:", error);
        // Safely return the error so the frontend can read it instead of crashing
        return res.status(500).json({ success: false, message: error.message });
    }
}
