import Groq from 'groq-sdk';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc } from 'firebase/firestore';

// 1. Initialize Firebase inside your serverless function
const firebaseConfig = {
    apiKey: "AIzaSyD0q99R9wn-r6e5aygL2zzg7e-Gc439ssY",
    authDomain: "cometchat-ai-platform.firebaseapp.com",
    projectId: "cometchat-ai-platform",
    storageBucket: "cometchat-ai-platform.firebasestorage.app",
    messagingSenderId: "604438924597",
    appId: "1:604438924597:web:a180d59f7f00385138507c"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// 2. Initialize Groq (We read your key securely using Vercel environment configurations)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export default async function handler(req, res) {
    // Inject global CORS routing parameters so widgets can query from any domain cleanly
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

    try {
        const { businessId, question } = req.body;

        if (!businessId || !question) {
            return res.status(400).json({ answer: "Invalid query package context." });
        }

        // 3. Look up the synced website matrix text data from Firestore
        const docRef = doc(db, "user_bots", businessId);
        const docSnap = await getDoc(docRef);

        let systemContext = "You are a helpful customer service assistant.";
        
        if (docSnap.exists()) {
            const botData = docSnap.data();
            // Assuming your scraper stores the page details inside a 'context' field
            if (botData.context) {
                systemContext = `You are a professional, factual customer support AI assistant for a website.
                Use ONLY the following business context to answer the user's questions: 
                ---
                ${botData.context}
                ---
                If the answer cannot be found in the context, politely say that you don't have that information.`;
            }
        }

        // 4. Ping Llama 3.1 via Groq for an instantaneous processing return loop
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: systemContext },
                { role: "user", content: question }
            ],
            model: "llama3-8b-8192", // Lightning-fast Llama 3.1 execution model
            temperature: 0.2
        });

        const replyText = chatCompletion.choices[0]?.message?.content || "I'm sorry, I'm having trouble compiling a response right now.";

        return res.status(200).json({ answer: replyText });

    } catch (error) {
        console.error("Chat engine traceback:", error);
        return res.status(500).json({ answer: "System connectivity error. Please try again." });
    }
}