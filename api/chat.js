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

// Helper function to handle webhooks smoothly
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

            const leadGenPrompt = `\n\nCRITICAL INSTRUCTION: You are an automation assistant for CometNotes PRO.
- If the user explicitly asks to book, schedule, or reserve an appointment, meeting, or call, use the 'bookAppointment' tool.
- If the user asks general informational questions (like "What is CometNotes PRO?", "hi", "hello"), simply reply to them using helpful conversational text. Do NOT use tools for general conversations.
- If they ask about general pricing or specialized help, proactively gather their email or phone number.`;
            
            if (knowledge.systemPrompt) {
                systemContext = knowledge.systemPrompt + leadGenPrompt;
            } else if (botData.context) {
                systemContext = `Use this context: ${botData.context}` + leadGenPrompt;
            }

            if (knowledge.fileContents) {
                systemContext += `\n\n[REFERENCE DATA]:\n${knowledge.fileContents}`;
            }
        }

        const toolsDefinition = [
            {
                type: "function",
                function: {
                    name: "bookAppointment",
                    description: "Use this tool ONLY when the user explicitly says they want to book, schedule, or request an appointment or meeting.",
                    parameters: {
                        type: "object",
                        properties: {
                            purpose: { type: "string", description: "The reason or details for the appointment." }
                        },
                        required: ["purpose"]
                    }
                }
            }
        ];

        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: systemContext },
                { role: "user", content: promptText }
            ],
            model: "llama-3.1-8b-instant",
            tools: toolsDefinition,
            tool_choice: "auto",
            temperature: 0.4,
            max_tokens: 1024,
        });

        const choice = chatCompletion.choices[0]?.message;
        
        // INTERCEPT BOOKING TOOL CALLS AND WRITE TO DATABASE + TRIGGER WEBHOOKS
        if (choice?.tool_calls && choice.tool_calls.length > 0) {
            const toolCall = choice.tool_calls[0];
            if (toolCall.function.name === "bookAppointment") {
                
                const appointmentData = {
                    businessId: businessId,
                    botName: botName,
                    owner: ownerEmail,
                    purpose: "Appointment Request: " + promptText,
                    status: "requested",
                    createdAt: new Date().toISOString()
                };

                // Save to global appointments collection so dashboard picks it up instantly
                await addDoc(collection(db, "appointments"), appointmentData);

                // Also save under bot subcollection for absolute redundancy safety
                await addDoc(collection(db, "user_bots", businessId, "appointments"), appointmentData);

                // Instantly sync data onto third-party webhooks (Google Calendar & WhatsApp alerts)
                if (integrations.googleCalendar) await triggerWebhook(integrations.googleCalendar, appointmentData);
                if (integrations.whatsappAlerts) await triggerWebhook(integrations.whatsappAlerts, appointmentData);

                return res.status(200).json({ 
                    success: true, 
                    answer: "Success in booking: Your appointment has been requested.",
                    reply: "Success in booking: Your appointment has been requested.",
                    triggerBookingUI: true 
                });
            }
        }

        let replyText = choice?.content || "";
        
        // Text fallback interception logic
        if (replyText.includes("bookAppointment=") || replyText.includes("brave_search=")) {
            if (replyText.includes("bookAppointment")) {
                const appointmentData = {
                    businessId: businessId,
                    botName: botName,
                    owner: ownerEmail,
                    purpose: "Appointment Request",
                    status: "requested",
                    createdAt: new Date().toISOString()
                };
                await addDoc(collection(db, "appointments"), appointmentData);
                if (integrations.googleCalendar) await triggerWebhook(integrations.googleCalendar, appointmentData);
                
                return res.status(200).json({ 
                    success: true, 
                    answer: "Success in booking: Your appointment has been requested.",
                    reply: "Success in booking: Your appointment has been requested.",
                    triggerBookingUI: true 
                });
            } else {
                replyText = "I can help answer questions about CometNotes PRO or assist you with booking an appointment! What can I do for you?";
            }
        }

        // Standard Lead Extraction Engine
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

            if (integrations.whatsappAlerts) await triggerWebhook(integrations.whatsappAlerts, leadData);
            if (integrations.googleCalendar) await triggerWebhook(integrations.googleCalendar, leadData);
        }
        
        if (!replyText) replyText = "I'm here to answer your questions about CometNotes PRO! How can I help you today?";
        return res.status(200).json({ success: true, answer: replyText, reply: replyText });

    } catch (error) {
        console.error("Chat Error:", error);
        return res.status(200).json({ success: true, answer: "I didnt quite get that, Could you please try rephrasing that?", reply: "I didnt quite get that, Could you please try rephrasing that?"" });
    }
}
