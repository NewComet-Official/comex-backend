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
        // Accept either 'message' (from your test panel) or 'question' (from your older formats)
        const { businessId, message, question, conversationId } = req.body;
        const activeUserText = message || question;

        const app = initializeApp(firebaseConfig);
        const db = getFirestore(app);
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

        if (!businessId) {
            return res.status(200).json({ success: false, message: "Debug Error: The widget failed to send a businessId inside the request body." });
        }

        if (!activeUserText) {
            return res.status(200).json({ success: false, message: "Debug Error: No prompt text provided in 'message' or 'question'." });
        }

        const docRef = doc(db, "user_bots", businessId);
        const docSnap = await getDoc(docRef);

        let systemContext = "You are a helpful assistant.";
        
        if (!docSnap.exists()) {
            return res.status(200).json({ 
                success: false,
                message: `Debug Alert: Bot document was not found matching ID: "${businessId}".` 
            });
        }

        const botData = docSnap.data();
        const activeContext = botData.context || botData.text || botData.scrapedData || "";

        systemContext = `You are a professional customer support assistant. 
        Use ONLY the following context to answer the user's questions:
        ---
        ${activeContext}
        ---
        If the answer cannot be found in the context, politely say you don't know.`;

        // 🚀 Call Groq ensuring correct schema format
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: systemContext },
                { role: "user", content: activeUserText } // Using mapped string variable
            ],
            model: "llama-3.1-8b-instant",
            temperature: 0.2,
        });

        const botReply = chatCompletion.choices[0].message.content;

        // 📊 AUTOMATIC FIRESTORE LOGGING PIPELINE
        // Checks if a message looks like a captured customer lead conversion
        const textToAnalyze = activeUserText.toLowerCase();
        const containsLeadIndicator = textToAnalyze.includes('@') || 
                                     textToAnalyze.includes('.com') || 
                                     textToAnalyze.match(/\b\d{10}\b/);

        // Build a structured log matching what your ROI loop reads
        const chatLogPayload = {
            conversationId: conversationId || `session-${Date.now()}`,
            isEscalated: false,
            timestamp: new Date().toISOString(),
            messages: [
                { sender: "user", text: activeUserText },
                { sender: "bot", text: botReply }
            ]
        };

        // Write the log directly into the chats subcollection of this specific bot
        const chatsSubcollectionRef = collection(db, "user_bots", businessId, "chats");
        await addDoc(chatsSubcollectionRef, chatLogPayload);

        // Send standard payload structure back to the frontend sandbox
        res.status(200).json({ 
            success: true, 
            reply: botReply,
            answer: botReply // Keeps backwards compatibility for older versions
        });

    } catch (error) {
        res.status(200).json({ success: false, message: `Backend Error: ${error.message}` });
    }
}
