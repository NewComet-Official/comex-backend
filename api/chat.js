import Groq from 'groq-sdk';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, collection, addDoc } from 'firebase/firestore';

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
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        const { businessId, message, question, conversationId } = req.body;
        const activeUserText = message || question;

        const app = initializeApp(firebaseConfig);
        const db = getFirestore(app);
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

        if (!businessId || !activeUserText) {
            return res.status(200).json({ success: false, message: "Missing required payload parameters." });
        }

        const docRef = doc(db, "user_bots", businessId);
        const docSnap = await getDoc(docRef);

        if (!docSnap.exists()) {
            return res.status(200).json({ success: false, message: "Bot document not found." });
        }

        const botData = docSnap.data();
        const activeContext = botData.context || botData.text || botData.scrapedData || "";

        const systemContext = `You are a professional customer support assistant. 
        Use ONLY the following context to answer the user's questions:
        ---\n${activeContext}\n---
        If the answer cannot be found in the context, politely say you don't know.`;

        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: systemContext },
                { role: "user", content: activeUserText }
            ],
            model: "llama-3.1-8b-instant",
            temperature: 0.2,
        });

        const botReply = chatCompletion.choices[0].message.content;

        // 🧠 INTENT DETECTION GUARD
        const cleanMsg = activeUserText.toLowerCase().trim();
        const structuralGreetings = ['hi', 'hello', 'hey', 'test', 'hola', 'yo', 'sup'];
        
        // A chat is genuine ONLY if it's not a quick greeting AND contains real text length
        let isGenuine = true;
        if (structuralGreetings.includes(cleanMsg) || cleanMsg.length <= 4) {
            isGenuine = false;
        }

        // Check for lead acquisition
        const containsLeadIndicator = cleanMsg.includes('@') || cleanMsg.includes('.com') || cleanMsg.match(/\b\d{10}\b/);

        const chatLogPayload = {
            conversationId: conversationId || `session-${Date.now()}`,
            isEscalated: false,
            isGenuineQuery: isGenuine, // 👈 New analytical parameter tracking flag
            isLeadCaptured: !!containsLeadIndicator,
            timestamp: new Date().toISOString(),
            messages: [
                { sender: "user", text: activeUserText },
                { sender: "bot", text: botReply }
            ]
        };

        const chatsSubcollectionRef = collection(db, "user_bots", businessId, "chats");
        await addDoc(chatsSubcollectionRef, chatLogPayload);

        res.status(200).json({ 
            success: true, 
            reply: botReply,
            answer: botReply 
        });

    } catch (error) {
        res.status(200).json({ success: false, message: `Backend Error: ${error.message}` });
    }
}
