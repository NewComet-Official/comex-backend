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
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

    try {
        const { businessId, question, message } = req.body;
        const promptText = question || message;

        if (!businessId || !promptText) {
            return res.status(400).json({ success: false, answer: "Missing prompt payload parameters." });
        }

        const app = initializeApp(firebaseConfig);
        const db = getFirestore(app);
        
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

        const docRef = doc(db, "user_bots", businessId);
        const docSnap = await getDoc(docRef);

        // 1. Build the dynamic system context
        let systemContext = "You are a helpful customer service assistant.";
        
        if (docSnap.exists()) {
            const botData = docSnap.data();
            const knowledge = botData.knowledgeContext || {};

            // Start with custom instructions if they exist
            if (knowledge.systemPrompt) {
                systemContext = knowledge.systemPrompt;
            } else if (botData.context) {
                systemContext = `You are a helpful customer support assistant. Use this context: ${botData.context}`;
            }

            // 2. Inject file contents if they exist in the database
            if (knowledge.fileContents) {
                systemContext += `\n\n[REFERENCE DATA]:\n${knowledge.fileContents}`;
            }
        }

        // 3. Generate completion using the more capable 70b model
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: systemContext },
                { role: "user", content: promptText }
            ],
            model: "llama-3.1-8b-instant",
            temperature: 0.5,
            max_tokens: 1024,
        });

        const replyText = chatCompletion.choices[0]?.message?.content || "No response generated.";
        
        return res.status(200).json({ 
            success: true,
            answer: replyText, 
            reply: replyText 
        });

    } catch (error) {
        console.error("Chat Error:", error);
        return res.status(500).json({ success: false, answer: "Internal server processing fault." });
    }
}
