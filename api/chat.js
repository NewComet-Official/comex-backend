import Groq from 'groq-sdk';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, doc, getDoc, collection, addDoc } from 'firebase/firestore';

const firebaseConfig = {
    apiKey: "AIzaSyD0q99R9wn-r6e5aygL2zzg7e-Gc439ssY",
    authDomain: "cometchat-ai-platform.firebaseapp.com",
    projectId: "cometchat-ai-platform",
    storageBucket: "cometchat-ai-platform.firebasestorage.app",
    messagingSenderId: "604438924597",
    appId: "1:604438924597:web:a180d59f7f00385138507c"
};

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(app);

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

    try {
        const { businessId, question, message } = req.body;
        const promptText = question || message;

        if (!businessId || !promptText) return res.status(400).json({ success: false, answer: "Missing prompt payload." });
        if (!process.env.GROQ_API_KEY) return res.status(500).json({ success: false, answer: "Server config error." });

        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const docRef = doc(db, "user_bots", businessId);
        const docSnap = await getDoc(docRef);

        let systemContext = "You are a helpful customer service assistant.";
        let ownerEmail = "unknown";
        let botName = "Agent";

        if (docSnap.exists()) {
            const botData = docSnap.data();
            const knowledge = botData.knowledgeContext || {};
            ownerEmail = botData.owner;
            botName = botData.name;

            // UNICORN UPGRADE: The Lead Generation Prompt
            const leadGenPrompt = `\n\nCRITICAL INSTRUCTION: You are a lead generation agent. If the user asks for pricing, booking, or specialized help, proactively ask for their email or phone number to 'have the team reach out'.`;
            
            if (knowledge.systemPrompt) systemContext = knowledge.systemPrompt + leadGenPrompt;
            else if (botData.context) systemContext = `Use this context: ${botData.context}` + leadGenPrompt;

            if (knowledge.fileContents) systemContext += `\n\n[REFERENCE DATA]:\n${knowledge.fileContents}`;
        }

        // 1. Generate AI Response
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: systemContext },
                { role: "user", content: promptText }
            ],
            model: "llama-3.1-70b-versatile",
            temperature: 0.5,
            max_tokens: 1024,
        });

        const replyText = chatCompletion.choices[0]?.message?.content || "No response generated.";

        // 2. UNICORN UPGRADE: Lead Extraction Engine
        // Simple regex to catch emails and basic phone numbers
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const phoneRegex = /(\+\d{1,2}\s?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
        
        const foundEmails = promptText.match(emailRegex) || [];
        const foundPhones = promptText.match(phoneRegex) || [];

        if (foundEmails.length > 0 || foundPhones.length > 0) {
            // Save the captured lead to Firestore
            await addDoc(collection(db, "leads"), {
                businessId: businessId,
                botName: botName,
                owner: ownerEmail,
                contactInfo: [...foundEmails, ...foundPhones].join(", "),
                contextReason: promptText.substring(0, 100) + "...", // Save what they were asking about
                createdAt: new Date().toISOString()
            });

            // NOTE FOR FUTURE: This is exactly where you would trigger a 
            // webhook to Twilio (WhatsApp) or Google Calendar API!
        }
        
        return res.status(200).json({ success: true, answer: replyText, reply: replyText });

    } catch (error) {
        console.error("Chat Error:", error);
        return res.status(500).json({ success: false, answer: "Internal server processing fault." });
    }
}
