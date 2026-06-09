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
        let integrations = {};

        if (docSnap.exists()) {
            const botData = docSnap.data();
            const knowledge = botData.knowledgeContext || {};
            ownerEmail = botData.owner;
            botName = botData.name;
            integrations = botData.integrations || {};

            // 1. UPDATED PROMPT: Directs the LLM to use the function call for booking requests
            const leadGenPrompt = `\n\nCRITICAL INSTRUCTION: You are an automation assistant for CometNotes PRO. You have access to a tool named 'bookAppointment'. Whenever a user explicitly requests to book, schedule, or reserve an appointment, meeting, or call, you MUST call the 'bookAppointment' function tool. Do NOT output a conversational response saying you cannot book or that you are just a browser extension. Use your system tools. If they ask about simple pricing or general sales, then proactively gather their email/phone info.`;
            
            if (knowledge.systemPrompt) {
                systemContext = knowledge.systemPrompt + leadGenPrompt;
            } else if (botData.context) {
                systemContext = `Use this context: ${botData.context}` + leadGenPrompt;
            }

            if (knowledge.fileContents) {
                systemContext += `\n\n[REFERENCE DATA]:\n${knowledge.fileContents}`;
            }
        }

        // 2. ADDED TOOLS SCHEMA: Let Groq Llama 3.1 understand it has a function to call
        const toolsDefinition = [
            {
                type: "function",
                function: {
                    name: "bookAppointment",
                    description: "Triggers the system appointment registration UI workflow when a user requests a custom meeting, call slot, or appointment reservation.",
                    parameters: {
                        type: "object",
                        properties: {
                            purpose: { type: "string", description: "The reason or context for scheduling the appointment." }
                        },
                        required: ["purpose"]
                    }
                }
            }
        ];

        // Generate AI Response with tool configuration enabled
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: systemContext },
                { role: "user", content: promptText }
            ],
            model: "llama-3.1-8b-instant",
            tools: toolsDefinition,
            tool_choice: "auto",
            temperature: 0.3, // Lowered slightly for more deterministic tool selection execution
            max_tokens: 1024,
        });

        const choice = chatCompletion.choices[0]?.message;
        let replyText = choice?.content || "";

        // 3. CHECK FOR TOOL CALL RESPONSES:
        if (choice?.tool_calls && choice.tool_calls.length > 0) {
            const toolCall = choice.tool_calls[0];
            if (toolCall.function.name === "bookAppointment") {
                // If Llama decides to call the tool, intercept it and instruct your frontend to surface the booking UI card 
                return res.status(200).json({ 
                    success: true, 
                    answer: "Success in booking: Your appointment has been requested.",
                    reply: "Success in booking: Your appointment has been requested.",
                    triggerBookingUI: true // Custom flag your frontend script can read to render the appointment form!
                });
            }
        }

        // Lead Extraction Engine (Runs if it's normal conversational response)
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const phoneRegex = /(\+\d{1,2}\s?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
        
        const foundEmails = promptText.match(emailRegex) || [];
        const foundPhones = promptText.match(phoneRegex) || [];

        if (foundEmails.length > 0 || foundPhones.length > 0) {
            const contactString = [...foundEmails, ...foundPhones].join(", ");
            const leadData = {
                businessId: businessId,
                botName: botName,
                owner: ownerEmail,
                contactInfo: contactString,
                contextReason: promptText.substring(0, 100) + "...", 
                createdAt: new Date().toISOString()
            };

            await addDoc(collection(db, "leads"), leadData);

            const triggerWebhook = async (url, data) => {
                if (!url) return;
                try {
                    await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(data)
                    });
                } catch (e) { console.error("Webhook trigger failed for:", url, e); }
            };

            if (integrations.whatsappAlerts) triggerWebhook(integrations.whatsappAlerts, leadData);
            if (integrations.googleCalendar) triggerWebhook(integrations.googleCalendar, leadData);
        }
        
        if (!replyText) replyText = "No response generated.";
        return res.status(200).json({ success: true, answer: replyText, reply: replyText });

    } catch (error) {
        console.error("Chat Error:", error);
        return res.status(500).json({ success: false, answer: "Internal server processing fault." });
    }
}
