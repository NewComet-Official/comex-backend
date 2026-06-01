import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

// 1. SAFELY INITIALIZE FIREBASE ADMIN
// If Vercel environment variables are missing, this fallback string prevents an immediate JSON parse crash
const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY || "{}";
let serviceAccount;
try {
    serviceAccount = JSON.parse(serviceAccountRaw);
} catch (e) {
    serviceAccount = {};
}

if (!getApps().length && serviceAccount.project_id) {
    initializeApp({ credential: cert(serviceAccount) });
}

// Regular expressions to check for Lead Tracking
const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const phoneRegex = /(\+?\d{1,4}[\s-])?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/;

export default async function handler(req, res) {
    // 2. FORCE CORS HEADERS TO SEND IMMEDIATELY
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    // Handle preflight browser check safely
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    // 3. CHECK IF ENVIRONMENT VARIABLES ARE CONFIGURED BEFORE ACCESSING DB
    if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
        return res.status(500).json({ 
            success: false, 
            message: 'Backend Configuration Error: FIREBASE_SERVICE_ACCOUNT_KEY is missing in Vercel settings.' 
        });
    }

    try {
        const db = getFirestore();
        const { businessId, hourlySupportCost = 20, leadValue = 50 } = req.body;

        if (!businessId) {
            return res.status(400).json({ success: false, message: 'Missing businessId parameter.' });
        }

        // Fetch all raw chats logged by Llama 3.1
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
        console.error("ROI Calc Error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}
