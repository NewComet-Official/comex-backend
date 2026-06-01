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
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        const { businessId, question } = req.body;

        const app = initializeApp(firebaseConfig);
        const db = getFirestore(app);
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

        // 🔍 Debug log checking
        if (!businessId) {
            return res.status(200).json({ answer: "Debug Error: The widget failed to send a businessId inside the request body." });
        }

        const docRef = doc(db, "user_bots", businessId);
        const docSnap = await getDoc(docRef);

        let systemContext = "You are a helpful assistant.";
        
        // 🌟 CHECK 1: Does the document even exist in Firestore?
        if (!docSnap.exists()) {
            return res.status(200).json({ 
                answer: `Debug Alert: Connected to database successfully, but NO bot document was found matching the ID: "${businessId}". Check if this matches your Firestore collection ID.` 
            });
        }

        const botData = docSnap.data();
        
        // 🌟 CHECK 2: Look for the exact text data key
        // We will check for 'context', 'text', or 'scrapedData' automatically.
        const activeContext = botData.context || botData.text || botData.scrapedData;

        if (!activeContext) {
            return res.status(200).json({ 
                answer: `Debug Alert: Found document for "${businessId}", but the fields ('context', 'text', 'scrapedData') are empty! Available keys in your database are: ${Object.keys(botData).join(', ')}` 
            });
        }

        // Build system rules safely using the data found
        systemContext = `You are a professional customer support assistant. 
        Use ONLY the following context to answer the user's questions:
        ---
        ${activeContext}
        ---
        If the answer cannot be found in the context, politely say you don't know.`;

        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: systemContext },
                { role: "user", content: question }
            ],
            model: "llama-3.1-8b-instant",
            temperature: 0.2,
        });

        res.status(200).json({ answer: chatCompletion.choices[0].message.content });
    } catch (error) {
        res.status(200).json({ answer: `Backend Error: ${error.message}` });
    }
}
