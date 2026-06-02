import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';

// Your static Firebase web application settings configuration
const firebaseConfig = {
    apiKey: "AIzaSyD0q99R9wn-r6e5aygL2zzg7e-Gc439ssY",
    authDomain: "cometchat-ai-platform.firebaseapp.com",
    projectId: "cometchat-ai-platform",
    storageBucket: "cometchat-ai-platform.firebasestorage.app",
    messagingSenderId: "604438924597",
    appId: "1:604438924597:web:a180d59f7f00385138507c"
};

export default async function handler(req, res) {
    // 🌐 HANDLE CORS CROSS-ORIGIN RESOURCE SHARING HEADERS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        const { businessId } = req.body;

        if (!businessId) {
            return res.status(200).json({ success: false, message: "Missing businessId parameter." });
        }

        // Initialize Firebase
        const app = initializeApp(firebaseConfig);
        const db = getFirestore(app);

        // Fetch all chat logs from the bot's sub-collection
        const chatsSubcollectionRef = collection(db, "user_bots", businessId, "chats");
        const querySnapshot = await getDocs(chatsSubcollectionRef);

        let genuineChatCount = 0;
        let leadCount = 0;
        let totalChatsParsed = 0;

        // 📊 INTERPRET DATA SMARTER
        querySnapshot.forEach((docSnap) => {
            const chatData = docSnap.data();
            totalChatsParsed++;

            // Check our new smart analytical parameter flag
            // Fallback to true if it's an old legacy log without the key so old data stays intact
            const isGenuine = chatData.isGenuineQuery !== undefined ? chatData.isGenuineQuery : true;

            if (isGenuine) {
                genuineChatCount++;
            }

            // Check if a lead (email/phone) was captured during this conversation
            if (chatData.isLeadCaptured || chatData.leadCaptured) {
                leadCount++;
            }
        });

        // 📈 BUSINESS METRICS CALCULATIONS (Running ONLY on genuine interactions)
        // Adjust these variables based on your actual business estimates
        const minutesSavedPerChat = 15; // Assume each real customer query saves 15 mins of human work
        const hourlySupportCost = 20;   // Assume a customer support agent costs $20/hour
        const averageLeadValue = 50;    // Assume capturing a customer lead is worth $50 to the business

        // 1. Calculate hours saved
        const estimatedHoursSaved = parseFloat(((genuineChatCount * minutesSavedPerChat) / 60).toFixed(1));

        // 2. Calculate customer support labor costs saved
        const supportCostSavings = genuineChatCount * ((minutesSavedPerChat / 60) * hourlySupportCost);

        // 3. Calculate potential revenue generated from captured leads
        const potentialLeadRevenue = leadCount * averageLeadValue;

        // 4. Combined total Net ROI
        const netROI = supportCostSavings + potentialLeadRevenue;

        // 5. Calculate resolution rate cleanly
        const resolutionRate = genuineChatCount > 0 
            ? Math.round(((genuineChatCount - leadCount) / genuineChatCount) * 100) 
            : 100;

        // Return clean metrics payload back to the frontend dashboard UI
       // ── REPLACE THE BOTTOM OF YOUR api/calculate-roi FILE WITH THIS ──

        // Return flat metrics payload back to the frontend dashboard UI
        res.status(200).json({
            success: true,
            totalConversations: totalChatsParsed,      
            genuineConversations: genuineChatCount,  
            hoursSaved: estimatedHoursSaved,
            moneySaved: parseFloat(netROI.toFixed(2)), // Matches old frontend data.moneySaved
            leadsCaptured: leadCount,
            resolutionRate: resolutionRate
        });

    } catch (error) {
        res.status(200).json({ success: false, message: `ROI Calculation Backend Error: ${error.message}` });
    }
}
