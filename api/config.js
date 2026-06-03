import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc } from 'firebase/firestore';

const firebaseConfig = {
    apiKey: "AIzaSyD0q99R9wn-r6e5aygL2zzg7e-Gc439ssY",
    authDomain: "cometchat-ai-platform.firebaseapp.com",
    projectId: "cometchat-ai-platform",
    storageBucket: "cometchat-ai-platform.firebasestorage.app",
    messagingSenderId: "604438924597",
    appId: "1:604438924597:web:a180d59f7f00385138507c"
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { businessId } = req.query;
    if (!businessId) {
        return res.status(400).json({ success: false, error: "Missing businessId parameter." });
    }

    try {
        const app = initializeApp(firebaseConfig);
        const db = getFirestore(app);
        const docRef = doc(db, "user_bots", businessId);
        const docSnap = await getDoc(docRef);

        if (!docSnap.exists()) {
            return res.status(404).json({ success: false, error: "Configuration context profile not found." });
        }

        const botData = docSnap.data();
        return res.status(200).json({
            success: true,
            name: botData.name || "AI Assistant",
            position: botData.position || "bottom-right",
            logoBase64: botData.logoBase64 || null,
            // Delivers all your customized design selectors securely
            designConfig: botData.designConfig || {}
        });
    } catch (error) {
        console.error("Config Fetch Error:", error);
        return res.status(500).json({ success: false, error: "Internal Server Fault." });
    }
}
