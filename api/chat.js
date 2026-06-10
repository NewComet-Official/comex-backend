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
// IMPROVED APPOINTMENT BOOKING FLOW
// ============================================================================

const APPOINTMENT_WORKFLOW_PROMPT = `
You are an intelligent appointment booking assistant for {{botName}}.

CRITICAL WORKFLOW - Follow EXACTLY:

When a user wants to book an appointment, you MUST collect information in this order:
1. CUSTOMER NAME - Ask: "What's your name?"
2. CONTACT INFO - Ask: "What's your email or phone number?"
3. DATE - Ask: "What date would you prefer? (e.g., Thursday, December 12)"
4. TIME - Ask: "What time works best? (e.g., 2:00 PM)"

IMPORTANT RULES:
- NEVER skip steps or assume any information
- ONLY proceed to booking after you have ALL 4 pieces of information
- If user gives partial info, acknowledge it and ask for the missing pieces
- For dates: Accept day names (Thursday) or full dates
- For times: Accept formats like "2 PM", "2:00 PM", "14:00"
- Always confirm the appointment details before finalizing

CHECKING AVAILABILITY:
- When user provides date and time, check if it's available
- If NOT available, offer alternatives: "That slot is taken. How about {{alternative_time}}?"
- Ask: "Would that work for you?" before booking

FINALIZATION:
Only trigger the appointmentBooking function when:
- You have confirmed NAME ✓
- You have confirmed CONTACT_INFO (email or phone) ✓  
- You have confirmed DATE ✓
- You have confirmed TIME ✓
- You have confirmed availability OR user accepted alternative ✓
- User explicitly confirmed ("Yes", "Sounds good", "Book it", etc.) ✓

FUNCTION CALL FORMAT:
{
  "userName": "customer's full name",
  "contactInfo": "email@example.com or +1234567890",
  "appointmentDay": "Thursday or full date string",
  "appointmentTime": "2:00 PM format",
  "appointmentDate": "Full ISO date string YYYY-MM-DD"
}

For non-booking questions, respond naturally and helpfully.
`;

export default async function handler(req, res) {
    // ============================================================================
    // CORS HEADERS - CRITICAL FIX
    // ============================================================================
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

    try {
        const { businessId, question, message, history = [], conversationId } = req.body;
        const promptText = question || message;

        if (!businessId || !promptText) {
            return res.status(400).json({ success: false, answer: "Missing required fields." });
        }

        if (!process.env.GROQ_API_KEY) {
            return res.status(500).json({ success: false, answer: "Server configuration error." });
        }

        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const docRef = doc(db, "user_bots", businessId);
        const docSnap = await getDoc(docRef);

        let systemContext = "You are a helpful customer service assistant.";
        let ownerEmail = "unknown";
        let botName = "Agent";
        let integrations = {};
        let botData = {};

        if (docSnap.exists()) {
            botData = docSnap.data();
            const knowledge = botData.knowledgeContext || {};
            ownerEmail = botData.owner;
            botName = botData.name;
            integrations = botData.integrations || {};
            
            const customWorkflow = APPOINTMENT_WORKFLOW_PROMPT
                .replace('{{botName}}', botName)
                .replace('{{alternative_time}}', '3:00 PM');
            
            if (knowledge.systemPrompt) {
                systemContext = knowledge.systemPrompt + '\n\n' + customWorkflow;
            } else if (botData.context) {
                systemContext = `Use this context: ${botData.context}\n\n${customWorkflow}`;
            } else {
                systemContext = customWorkflow;
            }

            if (knowledge.fileContents) {
                systemContext += `\n\n[REFERENCE DATA]:\n${knowledge.fileContents}`;
            }
        }

        const toolsDefinition = [
            {
                type: "function",
                function: {
                    name: "appointmentBooking",
                    description: "Book appointment ONLY after collecting name, contact, date, time AND user confirmation",
                    parameters: {
                        type: "object",
                        properties: {
                            userName: { type: "string", description: "Customer's full name" },
                            contactInfo: { type: "string", description: "Customer's email or phone" },
                            appointmentDay: { type: "string", description: "Day name or date (Thursday/2024-12-12)" },
                            appointmentTime: { type: "string", description: "Time in 12hr format (2:00 PM)" },
                            appointmentDate: { type: "string", description: "Full ISO date YYYY-MM-DD" }
                        },
                        required: ["userName", "contactInfo", "appointmentDay", "appointmentTime"]
                    }
                }
            }
        ];

        // Build conversation history
        let groqMessages = [{ role: "system", content: systemContext }];
        if (Array.isArray(history) && history.length > 0) {
            groqMessages = groqMessages.concat(history);
        }
        groqMessages.push({ role: "user", content: promptText });

        // Call Groq API
        const chatCompletion = await groq.chat.completions.create({
            messages: groqMessages,
            model: "llama-3.1-8b-instant",
            tools: toolsDefinition,
            tool_choice: "auto",
            temperature: 0.3,
            max_tokens: 1024,
        });

        const choice = chatCompletion.choices[0]?.message;

        // ============================================================================
        // HANDLE APPOINTMENT BOOKING
        // ============================================================================
        if (choice?.tool_calls && choice.tool_calls.length > 0) {
            const toolCall = choice.tool_calls[0];
            
            if (toolCall.function.name === "appointmentBooking") {
                const args = JSON.parse(toolCall.function.arguments);

                // Validate and sanitize data
                const finalizedName = (args.userName && args.userName.trim()) || "Guest";
                const finalizedContact = (args.contactInfo && args.contactInfo.trim()) || "Not Provided";
                const finalizedDay = (args.appointmentDay && args.appointmentDay.trim()) || "TBD";
                const finalizedTime = (args.appointmentTime && args.appointmentTime.trim()) || "TBD";

                // Parse date properly
                let appointmentDateISO = args.appointmentDate;
                if (!appointmentDateISO) {
                    const dateObj = parseAppointmentDate(finalizedDay);
                    appointmentDateISO = dateObj.toISOString().split('T')[0];
                }

                // ============================================================================
                // CHECK AVAILABILITY (If Google Calendar connected)
                // ============================================================================
                let availabilityCheck = { available: true };
                if (integrations.googleCalendar) {
                    availabilityCheck = await checkCalendarAvailability(
                        db,
                        ownerEmail,
                        appointmentDateISO,
                        finalizedTime
                    );
                }

                if (!availabilityCheck.available && availabilityCheck.suggestedTimes) {
                    return res.status(200).json({
                        success: true,
                        answer: `That time slot is already booked on your calendar. Here are available alternatives:\n${availabilityCheck.suggestedTimes
                            .map((t, i) => `${i + 1}. ${t.time} on ${t.date}`)
                            .join('\n')}\n\nWhich time works for you?`,
                        reply: "Slot taken - offering alternatives",
                        triggerBookingUI: false
                    });
                }

                // ============================================================================
                // CREATE APPOINTMENT RECORD
                // ============================================================================
                const appointmentData = {
                    businessId: businessId,
                    botName: botName,
                    owner: ownerEmail,
                    conversationId: conversationId,
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

                // Save to Firestore
                const appointmentRef = await addDoc(
                    collection(db, "appointments"),
                    appointmentData
                );

                await addDoc(
                    collection(db, "user_bots", businessId, "appointments"),
                    appointmentData
                );

                // ============================================================================
                // TRIGGER GOOGLE CALENDAR INTEGRATION
                // ============================================================================
                let calendarResult = { success: false };
                if (integrations.googleCalendar) {
                    calendarResult = await createGoogleCalendarEvent(db, ownerEmail, appointmentData);
                    
                    if (calendarResult.success) {
                        // Update appointment with calendar event ID
                        await updateDoc(appointmentRef, {
                            googleCalendarEventId: calendarResult.eventId,
                            googleCalendarLink: calendarResult.eventLink
                        });
                    }
                }

                // ============================================================================
                // TRIGGER WHATSAPP INTEGRATION
                // ============================================================================
                let whatsappResult = { success: false };
                if (integrations.whatsappAlerts && isValidPhoneNumber(finalizedContact)) {
                    appointmentData.customerWhatsApp = finalizedContact;
                    whatsappResult = await sendWhatsAppNotification(appointmentData);
                    
                    if (whatsappResult.success) {
                        await updateDoc(appointmentRef, {
                            whatsappMessageId: whatsappResult.messageId
                        });
                    }
                }

                // ============================================================================
                // BUILD CONFIRMATION MESSAGE
                // ============================================================================
                let confirmationMessage = `✅ Appointment Confirmed!\n\n`;
                confirmationMessage += `📅 Date: ${appointmentDateISO}\n`;
                confirmationMessage += `🕐 Time: ${finalizedTime}\n`;
                confirmationMessage += `👤 Booked for: ${finalizedName}\n`;
                confirmationMessage += `📧 Contact: ${finalizedContact}\n`;

                if (calendarResult.success) {
                    confirmationMessage += `\n✓ Added to your Google Calendar`;
                }

                if (whatsappResult.success) {
                    confirmationMessage += `\n✓ Confirmation sent via WhatsApp`;
                }

                confirmationMessage += `\n\nThank you for booking with us!`;

                return res.status(200).json({
                    success: true,
                    answer: confirmationMessage,
                    reply: confirmationMessage,
                    appointmentId: appointmentRef.id,
                    calendarEvent: calendarResult.success ? calendarResult.eventLink : null,
                    integrationStatus: {
                        googleCalendar: calendarResult.success,
                        whatsapp: whatsappResult.success
                    }
                });
            }
        }

        // For non-booking questions
        let replyText = choice?.content || "How can I help you today?";
        return res.status(200).json({ success: true, answer: replyText, reply: replyText });

    } catch (error) {
        console.error("Chat Flow Error:", error);
        return res.status(200).json({
            success: true,
            answer: "I can help you book an appointment! Could you please provide your name?",
            reply: "I can help you book an appointment!"
        });
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function parseAppointmentDate(dateString) {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const today = new Date();
    
    // Try to match day name
    const dayIndex = days.indexOf(dateString.toLowerCase().trim());
    if (dayIndex !== -1) {
        const resultDate = new Date(today);
        let daysToAdd = dayIndex - today.getDay();
        if (daysToAdd <= 0) daysToAdd += 7;
        resultDate.setDate(resultDate.getDate() + daysToAdd);
        return resultDate;
    }
    
    // Try to parse as date string
    const parsed = new Date(dateString);
    if (!isNaN(parsed.getTime())) {
        return parsed;
    }
    
    // Default to today
    return today;
}

function isValidPhoneNumber(contact) {
    // Simple phone validation
    return /^\+?[\d\s\-\(\)]{10,}$/.test(contact.replace(/\s/g, ''));
}
