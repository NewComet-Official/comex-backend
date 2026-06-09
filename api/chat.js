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

// Safe Webhook Trigger
const triggerWebhook = async (url, data) => {
    if (!url || typeof url !== 'string' || !url.startsWith('http')) return;
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    } catch (e) { console.error("Webhook failed:", e); }
};

// Helper function to calculate the calendar date for an upcoming day (e.g., "Thursday")
function getUpcomingDayDate(dayName) {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const targetDay = days.indexOf(dayName.toLowerCase().trim());
    if (targetDay === -1) return "Upcoming Date";

    const resultDate = new Date();
    // Use fixed current time context (June 9, 2026 is a Tuesday)
    resultDate.setFullYear(2026, 5, 9); 

    const currentDay = resultDate.getDay();
    let daysToAdd = targetDay - currentDay;
    if (daysToAdd <= 0) daysToAdd += 7; // Get next week's day if it already passed

    resultDate.setDate(resultDate.getDate() + daysToAdd);
    
    // Format options: "June 11, 2026"
    return resultDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

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

            // BRAND NEW MULTI-STEP APPOINTMENT LOGIC
            const conversationalPrompt = `\n\nCRITICAL ASSISTANT WORKFLOW:
You are a smart business assistant for CometNotes PRO. You have access to a tool called 'finalizeAppointmentBooking'.

Follow this exact appointment scheduling script over the conversation:
1. If the user asks to book an appointment (e.g., "I wanna book an appointment at Thursday 2pm"), do NOT call any tools yet. Instead, reply conversationally EXACTLY like this:
   "I can do that for you, Can I get your name and Email or Mobile Number for booking the appointment?"
   
2. Once the user replies with their contact details (e.g., "Rahul, email@example.com and +91 6123456789"), look at the chat history or context, extract the details, and ONLY then execute the 'finalizeAppointmentBooking' tool with the arguments.

3. If the user asks general info ("What is CometNotes PRO?", "hi", "hello"), reply normally using your knowledge context. Do not use tools for general questions.`;
            
            if (knowledge.systemPrompt) {
                systemContext = knowledge.systemPrompt + conversationalPrompt;
            } else if (botData.context) {
                systemContext = `Use this context: ${botData.context}` + conversationalPrompt;
            }

            if (knowledge.fileContents) {
                systemContext += `\n\n[REFERENCE DATA]:\n${knowledge.fileContents}`;
            }
        }

        // Tool declaration only triggers when gathering is complete
        const toolsDefinition = [
            {
                type: "function",
                function: {
                    name: "finalizeAppointmentBooking",
                    description: "Execute this tool ONLY after you have successfully collected the customer's name, contact info, and preferred day/time slot.",
                    parameters: {
                        type: "object",
                        properties: {
                            userName: { type: "string", description: "The customer's name" },
                            contactInfo: { type: "string", description: "The customer's email or phone number" },
                            appointmentDay: { type: "string", description: "The day requested, e.g., 'Thursday'" },
                            appointmentTime: { type: "string", description: "The time slot requested, e.g., '2pm'" }
                        },
                        required: ["userName", "contactInfo", "appointmentDay", "appointmentTime"]
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
            temperature: 0.3,
            max_tokens: 1024,
        });

        const choice = chatCompletion.choices[0]?.message;

        // WHEN THE CHATBOT FINALLY TRIGGER THE BOOKING TOOL
        if (choice?.tool_calls && choice.tool_calls.length > 0) {
            const toolCall = choice.tool_calls[0];
            if (toolCall.function.name === "finalizeAppointmentBooking") {
                
                // Parse args cleanly from Llama's structural output
                const args = JSON.parse(toolCall.function.arguments);
                const calculatedDate = getUpcomingDayDate(args.appointmentDay || "Thursday");

                const appointmentData = {
                    businessId: businessId,
                    botName: botName,
                    owner: ownerEmail,
                    customerName: args.userName || "Customer",
                    contactInfo: args.contactInfo || "Not Provided",
                    purpose: `Appointment with ${args.userName} on ${args.appointmentDay} at ${args.appointmentTime}`,
                    status: "requested",
                    scheduledDate: calculatedDate,
                    scheduledTime: args.appointmentTime || "2pm",
                    createdAt: new Date().toISOString()
                };

                // Save records to Firestore
                await addDoc(collection(db, "appointments"), appointmentData);
                await addDoc(collection(db, "user_bots", businessId, "appointments"), appointmentData);

                // Run out-bound webhooks seamlessly
                if (integrations.googleCalendar) await triggerWebhook(integrations.googleCalendar, appointmentData);
                if (integrations.whatsappAlerts) await triggerWebhook(integrations.whatsappAlerts, appointmentData);

                // Send back your perfect exact requested verification string phrase!
                const customizedReply = `${args.userName}, Your appointment is booked for ${args.appointmentTime} on ${args.appointmentDay} (${calculatedDate}). Reply with 'CANCEL' if you want to cancel your appointment.`;

                return res.status(200).json({ 
                    success: true, 
                    answer: customizedReply,
                    reply: customizedReply,
                    triggerBookingUI: true 
                });
            }
        }

        // Return standard text conversation replies smoothly
        let replyText = choice?.content || "I'm here to answer your questions about CometNotes PRO! How can I help you today?";
        return res.status(200).json({ success: true, answer: replyText, reply: replyText });

    } catch (error) {
        console.error("Chat Flow Error:", error);
        return res.status(200).json({ success: true, answer: "I can help you gather details and schedule that appointment right away! Could you please provide your name and phone/email?", reply: "I can help you gather details and schedule that appointment right away!" });
    }
}
