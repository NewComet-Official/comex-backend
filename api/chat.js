import Groq from 'groq-sdk';
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
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

    try {
        // Accept either 'question' (widget) or 'message' (dashboard index.html)
        const { businessId, question, message } = req.body;
        const queryText = question || message;

        if (!businessId || !queryText) {
            return res.status(400).json({ success: false, answer: "Missing payload details.", reply: "Missing payload details." });
        }

        const app = initializeApp(firebaseConfig);
        const db = getFirestore(app);
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

        const docRef = doc(db, "user_bots", businessId);
        const docSnap = await getDoc(docRef);

        let systemContext = "You are a helpful customer service assistant.";
        if (docSnap.exists()) {
            const botData = docSnap.data();
            if (botData.knowledgeContext && botData.knowledgeContext.systemPrompt) {
                systemContext = botData.knowledgeContext.systemPrompt;
            } else if (botData.context) {
                systemContext = `You are a helpful customer support assistant. Use this context: ${botData.context}`;
            }
        }

        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: systemContext },
                { role: "user", content: queryText }
            ],
            model: "llama3-8b-8192",
            temperature: 0.2
        });

        const replyText = chatCompletion.choices[0]?.message?.content || "No response generated.";
        
        // Return dual properties to satisfy both frontend callers seamlessly
        return res.status(200).json({ 
            success: true, 
            answer: replyText, 
            reply: replyText 
        });
    } catch (error) {
        console.error("Error:", error);
        return res.status(500).json({ success: false, answer: "Internal Server Error", reply: "Internal Server Error" });
    }
}
