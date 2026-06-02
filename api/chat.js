import Groq from 'groq-sdk';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, collection, addDoc } from 'firebase/firestore';

// Your static Firebase web application settings configuration
const firebaseConfig = {
    apiKey: "AIzaSyD0q99R9wn-r6e5aygL2zzg7e-Gc439ssY",
    authDomain: "cometchat-ai-platform.firebaseapp.com",
    projectId: "cometchat-ai-platform",
    storageBucket: "cometchat-ai-platform.firebasestorage.app",
    messagingSenderId: "604438924597",
    appId: "1:604438924597:web:a180d59f7f00385138507c"
};

export default async function handler(req, res) {
    // 🌐 HANDLE CORS CROSS-ORIGIN RESOURCE SHARING HEADERS FOR THE CHAT WIDGET
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

    // Handle standard browser preflight request requirements
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        // Destructure incoming attributes sent by either your dashboard sandbox panel or live code script
        const { businessId, message, question, conversationId } = req.body;
        
        // 🛠️ PARAMETER MAPPING: Fallback fallback mechanism to keep compatibility across versions
        const activeUserText = message || question;

        // Initialize connection sessions safely inside the environment execution space
        const app = initializeApp(firebaseConfig);
        const db = getFirestore(app);
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

        // Guard validation to shield the script execution against missing arguments
        if (!businessId) {
            return res.status(200).json({ 
                success: false, 
                message: "Debug Error: The widget failed to send a businessId inside the request body." 
            });
        }

        if (!activeUserText) {
            return res.status(200).json({ 
                success: false, 
                message: "Debug Error: No prompt text provided in 'message' or 'question' parameter attributes." 
            });
        }

        // Fetch corresponding document records for context injection parameters
        const docRef = doc(db, "user_bots", businessId);
        const docSnap = await getDoc(docRef);

        if (!docSnap.exists()) {
            return res.status(200).json({ 
                success: false,
                message: `Debug Alert: Bot document was not found matching ID: "${businessId}". Check your Firestore collection path parameters.` 
            });
        }

        const botData = docSnap.data();
        
        // Dynamic key detection logic targeting business background text files
        const activeContext = botData.context || botData.text || botData.scrapedData || "";

        // Establish boundaries for system behavioral instruction prompt profiles
        const systemContext = `You are a professional customer support assistant. 
        Use ONLY the following context to answer the user's questions:
        ---
        ${activeContext}
        ---
        If the answer cannot be found in the context, politely say you don't know.`;

        // 🚀 REQUEST GENERATION PIPELINE - Formatted properly with explicit system and content attributes
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: systemContext },
                { role: "user", content: activeUserText } 
            ],
            model: "llama-3.1-8b-instant",
            temperature: 0.2,
        });

        const botReply = chatCompletion.choices[0].message.content;

        // 🧠 SMART INTENT DETECTION ENGINE
        const cleanMsg = activeUserText.toLowerCase().trim();
        const structuralGreetings = ['hi', 'hello', 'hey', 'test', 'hola', 'yo', 'sup', 'greetings', 'hi there'];
        
        // A chat interaction is tagged as genuine ONLY if it is not a casual greeting and has baseline content length
        let isGenuine = true;
        if (structuralGreetings.includes(cleanMsg) || cleanMsg.length <= 4) {
            isGenuine = false;
        }

        // Check if the user text patterns suggest customer lead contact info entry points
        const containsLeadIndicator = cleanMsg.includes('@') || cleanMsg.includes('.com') || cleanMsg.match(/\b\d{10}\b/);

        // Build a structured historical tracking footprint log to submit into analytics tracking collections
        const chatLogPayload = {
            conversationId: conversationId || `session-${Date.now()}`,
            isEscalated: false,
            isGenuineQuery: isGenuine, 
            isLeadCaptured: !!containsLeadIndicator,
            timestamp: new Date().toISOString(),
            messages: [
                { sender: "user", text: activeUserText },
                { sender: "bot", text: botReply }
            ]
        };

        // Write historical conversation properties dynamically into the nested target subcollection
        const chatsSubcollectionRef = collection(db, "user_bots", businessId, "chats");
        await addDoc(chatsSubcollectionRef, chatLogPayload);

        // Return a structural wrapper response body layout providing cross-version property interfaces
        res.status(200).json({ 
            success: true, 
            reply: botReply,
            answer: botReply 
        });

    } catch (error) {
        // Clean tracking trace returns for runtime exceptions encountered inside execution steps
        res.status(200).json({ 
            success: false, 
            message: `Backend Error: ${error.message}` 
        });
    }
}
