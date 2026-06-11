import Groq from 'groq-sdk';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, doc, getDoc, collection, addDoc, updateDoc } from 'firebase/firestore';
import { createGoogleCalendarEvent, sendWhatsAppNotification, checkCalendarAvailability } from './integrations.js';

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

// ============================================================================
// APPOINTMENT BOOKING - SIDE CAPABILITY ADDON (not the primary personality)
// ============================================================================
const APPOINTMENT_ADDON_PROMPT = `
You also have the ability to book appointments when the user explicitly asks for one.

APPOINTMENT BOOKING RULES:
- Only start collecting booking info if the user clearly asks to book, schedule, or make an appointment.
- Collect info naturally in conversation — do NOT interrogate with rapid-fire questions.
- You need to collect: name, contact (email or phone), preferred date, and preferred time.
- CRITICAL: Read the entire conversation history before asking for anything. If the user already told you their name, do NOT ask for it again. If they gave their email, do NOT ask again.
- Once you have all 4 pieces confirmed by the user, call the appointmentBooking function.
- Never ask for info that is already present in the chat history.
- Keep a friendly, natural tone throughout — this is a conversation, not a form.

When calling appointmentBooking:
- userName: The customer's full name (REQUIRED)
- contactInfo: Email or phone number (REQUIRED)
- appointmentDay: The day name like "Thursday" or "Monday" (REQUIRED - ALWAYS include this!)
- appointmentTime: Time in 12-hour format like "2:00 PM" (REQUIRED)
- appointmentDate: Full ISO date like "2026-06-15" (OPTIONAL - you can omit this)

CRITICAL: The appointmentDay parameter is REQUIRED. Always extract or infer the day name from what the user said:
- If they said "2026-06-15", that's a Sunday, so set appointmentDay to "Sunday"
- If they said "Thursday", set appointmentDay to "Thursday"
- Never omit appointmentDay - it is ALWAYS required
`;

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

    try {
        const { businessId, question, message, history = [], conversationId: incomingConversationId } = req.body;
        const promptText = question || message;

        if (!businessId || !promptText) {
            return res.status(400).json({ success: false, answer: "Missing required fields." });
        }

        if (!process.env.GROQ_API_KEY) {
            return res.status(500).json({ success: false, answer: "Server configuration error." });
        }

        // ============================================================================
        // GENERATE CONVERSATION ID IF NOT PROVIDED
        // ============================================================================
        const conversationId = incomingConversationId || `conv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const docRef = doc(db, "user_bots", businessId);
        const docSnap = await getDoc(docRef);

        let systemContext = "You are a helpful, friendly customer service assistant.";
        let ownerEmail = "unknown";
        let botName = "Agent";
        let integrations = {};

        if (docSnap.exists()) {
            const botData = docSnap.data();
            const knowledge = botData.knowledgeContext || {};
            ownerEmail = botData.owner;
            botName = botData.name;
            integrations = botData.integrations || {};

            // Build primary system context from the business's own knowledge
            // The appointment addon is appended at the end — it's secondary, not the personality
            if (knowledge.systemPrompt) {
                systemContext = knowledge.systemPrompt;
            } else if (botData.context) {
                systemContext = `You are a helpful assistant for this business. Use the following information to answer customer questions accurately:\n\n${botData.context}`;
            }

            if (knowledge.fileContents) {
                systemContext += `\n\n[ADDITIONAL REFERENCE MATERIAL]:\n${knowledge.fileContents}`;
            }

            // Appointment capability is always appended as a side ability
            systemContext += `\n\n${APPOINTMENT_ADDON_PROMPT}`;
        }

        // ============================================================================
        // TOOL DEFINITION - CRITICAL: All 4 required params must match the prompt
        // ============================================================================
        const toolsDefinition = [
            {
                type: "function",
                function: {
                    name: "appointmentBooking",
                    description: "Book an appointment. Call ONLY when you have collected: name, contact, day, and time from the conversation.",
                    parameters: {
                        type: "object",
                        properties: {
                            userName: { 
                                type: "string", 
                                description: "Customer's full name (e.g., 'John Smith')" 
                            },
                            contactInfo: { 
                                type: "string", 
                                description: "Customer's email or phone number (e.g., 'john@example.com' or '+1234567890')" 
                            },
                            appointmentDay: { 
                                type: "string", 
                                description: "The day name ONLY (e.g., 'Monday', 'Thursday', 'Sunday'). DO NOT include the date here - just the day name!" 
                            },
                            appointmentTime: { 
                                type: "string", 
                                description: "Time in 12-hour format (e.g., '2:00 PM', '9:30 AM')" 
                            }
                        },
                        required: ["userName", "contactInfo", "appointmentDay", "appointmentTime"]
                    }
                }
            }
        ];

        // Build full conversation with history — this is what prevents the amnesia loop
        let groqMessages = [{ role: "system", content: systemContext }];
        if (Array.isArray(history) && history.length > 0) {
            groqMessages = groqMessages.concat(history);
        }
        groqMessages.push({ role: "user", content: promptText });

        const chatCompletion = await groq.chat.completions.create({
            messages: groqMessages,
            model: "llama-3.1-8b-instant",
            tools: toolsDefinition,
            tool_choice: "auto",
            temperature: 0.5,
            max_tokens: 1024,
        });

        const choice = chatCompletion.choices[0]?.message;

        // Handle appointment booking tool call
        if (choice?.tool_calls && choice.tool_calls.length > 0) {
            const toolCall = choice.tool_calls[0];

            if (toolCall.function.name === "appointmentBooking") {
                const args = JSON.parse(toolCall.function.arguments);

                // Validate all required fields are present
                if (!args.userName || !args.contactInfo || !args.appointmentDay || !args.appointmentTime) {
                    console.error("Missing required appointment fields:", args);
                    return res.status(200).json({
                        success: true,
                        answer: "I need to collect a bit more information. Could you please provide your name, contact info, preferred date, and time?",
                        reply: "Missing information to complete booking"
                    });
                }

                const finalizedName = args.userName.trim() || "Guest";
                const finalizedContact = args.contactInfo.trim() || "Not Provided";
                const finalizedDay = args.appointmentDay.trim() || "TBD";
                const finalizedTime = args.appointmentTime.trim() || "TBD";

                let appointmentDateISO = args.appointmentDate;
                if (!appointmentDateISO) {
                    const dateObj = parseAppointmentDate(finalizedDay);
                    appointmentDateISO = dateObj.toISOString().split('T')[0];
                }

                // Availability check (if Google Calendar connected)
                let availabilityCheck = { available: true };
                if (integrations.googleCalendar) {
                    availabilityCheck = await checkCalendarAvailability(db, ownerEmail, appointmentDateISO, finalizedTime);
                }

                if (!availabilityCheck.available && availabilityCheck.suggestedTimes) {
                    return res.status(200).json({
                        success: true,
                        answer: `That time slot is already booked. Here are some alternatives:\n${availabilityCheck.suggestedTimes.map((t, i) => `${i + 1}. ${t.time} on ${t.date}`).join('\n')}\n\nWhich works for you?`,
                        reply: "Slot taken - offering alternatives"
                    });
                }

                // ============================================================================
                // BUILD APPOINTMENT DATA - NO UNDEFINED FIELDS
                // ============================================================================
                const appointmentData = {
                    businessId: businessId || "unknown",
                    botName: botName || "Agent",
                    owner: ownerEmail || "unknown",
                    conversationId: conversationId || `conv-${Date.now()}`, // BULLETPROOF: Always has a value
                    customerName: finalizedName,
                    contactInfo: finalizedContact,
                    appointmentDay: finalizedDay,
                    appointmentTime: finalizedTime,
                    scheduledDate: appointmentDateISO,
                    scheduledTime: finalizedTime,
                    status: "confirmed",
                    createdAt: new Date().toISOString(),
                    googleCalendarEventId: null,
                    whatsappMessageId: null
                };

                // ============================================================================
                // VALIDATE ALL FIRESTORE FIELDS BEFORE SAVING
                // ============================================================================
                for (const [key, value] of Object.entries(appointmentData)) {
                    if (value === undefined || value === null) {
                        console.error(`CRITICAL: Field ${key} is ${value} - this will cause Firestore error!`);
                        appointmentData[key] = ""; // Replace undefined/null with empty string
                    }
                }

                // Save to Firestore
                const appointmentRef = await addDoc(collection(db, "appointments"), appointmentData);
                await addDoc(collection(db, "user_bots", businessId, "appointments"), appointmentData);

                let calendarResult = { success: false };
                if (integrations.googleCalendar) {
                    calendarResult = await createGoogleCalendarEvent(db, ownerEmail, appointmentData);
                    if (calendarResult.success) {
                        await updateDoc(appointmentRef, {
                            googleCalendarEventId: calendarResult.eventId,
                            googleCalendarLink: calendarResult.eventLink
                        });
                    }
                }

                let whatsappResult = { success: false };
                if (integrations.whatsappAlerts && isValidPhoneNumber(finalizedContact)) {
                    appointmentData.customerWhatsApp = finalizedContact;
                    whatsappResult = await sendWhatsAppNotification(appointmentData);
                    if (whatsappResult.success) {
                        await updateDoc(appointmentRef, { whatsappMessageId: whatsappResult.messageId });
                    }
                }

                let confirmationMessage = `✅ Appointment Confirmed!\n\n📅 Date: ${appointmentDateISO}\n🕐 Time: ${finalizedTime}\n👤 Name: ${finalizedName}\n📧 Contact: ${finalizedContact}`;
                if (calendarResult.success) confirmationMessage += `\n\n✓ Added to Google Calendar`;
                if (whatsappResult.success) confirmationMessage += `\n✓ WhatsApp confirmation sent`;
                confirmationMessage += `\n\nIs there anything else I can help you with?`;

                return res.status(200).json({
                    success: true,
                    answer: confirmationMessage,
                    reply: confirmationMessage,
                    appointmentId: appointmentRef.id,
                    calendarEvent: calendarResult.success ? calendarResult.eventLink : null
                });
            }
        }

        // Standard response
        const replyText = choice?.content || "How can I help you today?";
        return res.status(200).json({ success: true, answer: replyText, reply: replyText });

    } catch (error) {
        console.error("Chat Flow Error:", error);
        console.error("Error Stack:", error.stack);
        return res.status(500).json({
            success: false,
            answer: "Sorry, I ran into an issue. Please try again.",
            reply: "Sorry, I ran into an issue. Please try again.",
            error: error.message // Debug info
        });
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function parseAppointmentDate(dateString) {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const today = new Date();
    const dayIndex = days.indexOf(dateString.toLowerCase().trim());
    
    if (dayIndex !== -1) {
        const resultDate = new Date(today);
        let daysToAdd = dayIndex - today.getDay();
        if (daysToAdd <= 0) daysToAdd += 7;
        resultDate.setDate(resultDate.getDate() + daysToAdd);
        return resultDate;
    }
    
    const parsed = new Date(dateString);
    if (!isNaN(parsed.getTime())) return parsed;
    return today;
}

function isValidPhoneNumber(contact) {
    return /^\+?[\d\s\-\(\)]{10,}$/.test(contact.replace(/\s/g, ''));
}
