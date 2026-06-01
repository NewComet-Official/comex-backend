import Groq from 'groq-sdk';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc } from 'firebase/firestore';

// 1. Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyD0q99R9wn-r6e5aygL2zzg7e-Gc439ssY",
    authDomain: "cometchat-ai-platform.firebaseapp.com",
    projectId: "cometchat-ai-platform",
    storageBucket: "cometchat-ai-platform.firebasestorage.app",
    messagingSenderId: "604438924597",
    appId: "1:604438924597:web:a180d59f7f00385138507c"
};

export default async function handler(req, res) {
    // 🌟 CRITICAL: Set CORS headers immediately before ANY other logic runs
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // 🌟 CRITICAL: Answer the browser's preflight check right here and stop
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' });
    }

    try {
        const { businessId, question } = req.body;

        if (!businessId || !question) {
            return res.status(400).json({ answer: "Missing required fields." });
        }

        // Initialize Firebase and Groq safely inside the POST block
        const app = initializeApp(firebaseConfig);
        const db = getFirestore(app);
        
        // Ensure your Groq API key variable is named exactly like this in Vercel
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

        // Fetch the context text from Firestore
        const docRef = doc(db, "user_bots", businessId);
        const docSnap = await getDoc(docRef);

        let systemContext = "You are a helpful customer service assistant.";
        if (docSnap.exists()) {
            const botData = docSnap.data();
            if (botData.context) {
                systemContext = `You are a professional customer support assistant. 
                Use ONLY the following context to answer the user's questions:
                ---
                ${botData.context}
                ---
                If the answer cannot be found in the context, politely say you don't know.`;
            }
        }

        // Call Meta Llama 3.1 via Groq
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: systemContext },
                { role: "user", content: question }
            ],
            model: "llama3-8b-8192", // Official ID for Meta Llama 3.1 8B Instruct on Groq
            temperature: 0.2
        });

        const replyText = chatCompletion.choices[0]?.message?.content || "I couldn't process that.";
        return res.status(200).json({ answer: replyText });

    } catch (error) {
        console.error("Server Error:", error);
        // Returning a 200 even on error during testing ensures your widget 
        // will print the error message instead of triggering a CORS block!
        return res.status(200).json({ answer: `Backend Error: ${error.message}` });
    }
}
