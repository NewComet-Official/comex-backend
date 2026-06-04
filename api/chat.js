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
        // Fallback checks for both standard dashboards ('message') and custom widgets ('question')
        const { businessId, question, message } = req.body;
        const promptText = question || message;

        if (!businessId || !promptText) {
            return res.status(400).json({ success: false, answer: "Missing prompt payload parameters." });
        }

        const app = initializeApp(firebaseConfig);
        const db = getFirestore(app);
        
        // Initialize Groq client
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

        // Generate completion using Groq and Llama 3.1
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: systemContext
                },
                {
                    role: "user",
                    content: promptText
                }
            ],
            model: "llama-3.1-8b-instant", // You can switch to 'llama-3.1-70b-versatile' if you need the larger model
            temperature: 0.7,
            max_tokens: 1024,
        });

        const replyText = chatCompletion.choices[0]?.message?.content || "No response generated.";
        
        // Return both properties to satisfy the widget and dashboard playground 
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
