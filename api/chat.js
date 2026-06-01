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
    // 🌟 1. SET HEADERS IMMEDIATELY
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

    // 🌟 2. HANDLE PREFLIGHT IMMEDIATELY
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        const { businessId, question } = req.body;

        // 🌟 3. INITIALIZE CLIENTS INSIDE THE TRY BLOCK
        const app = initializeApp(firebaseConfig);
        const db = getFirestore(app);
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

        const docRef = doc(db, "user_bots", businessId);
        const docSnap = await getDoc(docRef);

        let context = "You are a helpful assistant.";
        if (docSnap.exists()) {
            context = docSnap.data().context || context;
        }

        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: context },
                { role: "user", content: question }
            ],
            model: "llama3-8b-8192", // Meta Llama 3.1 8B Instruct
            temperature: 0.5,
        });

        res.status(200).json({ answer: chatCompletion.choices[0].message.content });
    } catch (error) {
        console.error("Crash Log:", error);
        // We return 200 here so the widget shows the error text instead of a CORS block
        res.status(200).json({ answer: `Backend Error: ${error.message}` });
    }
}
