import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

// 1. Initialize Firebase Admin safely (prevents re-initialization crashes on Vercel)
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
}
const db = getFirestore();

// Regular expressions to check if a user dropped contact info (Lead Tracking)
const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const phoneRegex = /(\+?\d{1,4}[\s-])?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/;

export default async function handler(req, res) {
    // Enable CORS so your dashboard UI can fetch this data securely
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

    try {
        // Grab configuration variables passed from your UI
        const { businessId, hourlySupportCost = 20, leadValue = 50 } = req.body;

        if (!businessId) {
            return res.status(400).json({ success: false, message: 'Missing businessId parameter.' });
        }

        // 2. Fetch all raw chats logged by Llama 3.1 for this specific business
        const chatsSnapshot = await db.collection('user_bots')
                                      .doc(businessId)
                                      .collection('chats')
                                      .get();

        let totalChats = chatsSnapshot.size;
        let resolvedByAI = 0;
        let totalLeadsCaptured = 0;
        let totalMessagesProcessed = 0;

        // If no chats exist yet, return an empty but clean state to your UI
        if (totalChats === 0) {
            return res.status(200).json({
                success: true,
                metrics: { totalConversations: 0, resolutionRate: 0, financialSavings: 0, pipelineValue: 0, netROI: 0 }
            });
        }

        // 3. Scan through every single conversation record
        chatsSnapshot.forEach(doc => {
            const chatData = doc.data();
            const messages = chatData.messages || [];
            totalMessagesProcessed += messages.length;

            let containsLeadInfo = false;
            let escalatedToHuman = false;

            messages.forEach(msg => {
                // Check if the website visitor sent an email or phone number
                if (msg.sender === 'user') {
                    if (emailRegex.test(msg.text) || phoneRegex.test(msg.text)) {
                        containsLeadInfo = true;
                    }
                }
                
                // Check if the chat was escalated (user clicked human backup or bot triggered a handoff text)
                if (chatData.isEscalated || (msg.text && msg.text.toLowerCase().includes('transferring to a human'))) {
                    escalatedToHuman = true;
                }
            });

            if (containsLeadInfo) totalLeadsCaptured++;
            if (!escalatedToHuman) resolvedByAI++; // If it never needed a human, Llama 3.1 resolved it successfully!
        });

        // 4. Run our Math Formulas
        const resolutionRate = parseFloat(((resolvedByAI / totalChats) * 100).toFixed(1));
        
        // Every message processed saves roughly 1.5 minutes of live human typing speed
        const hoursSaved = (totalMessagesProcessed * 1.5) / 60;
        const totalCostSaved = parseFloat((hoursSaved * hourlySupportCost).toFixed(2));
        const leadValueGenerated = totalLeadsCaptured * leadValue;
        const totalROIEarned = totalCostSaved + leadValueGenerated;

        // 5. Structure the finalized analytics payload
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

        // 6. Save the snapshot back to Firestore under a dedicated analytics document
        await db.collection('user_bots')
                .doc(businessId)
                .collection('analytics')
                .doc('roi_dashboard')
                .set(metricsPayload, { merge: true });

        // Return the fresh stats directly back to your UI request
        return res.status(200).json({ success: true, metrics: metricsPayload });

    } catch (error) {
        console.error("ROI Calc Error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}