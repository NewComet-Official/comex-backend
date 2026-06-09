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

// ── NEW HELPER: REFRESH GOOGLE OAUTH & CREATE CALENDAR EVENT ──
async function insertGoogleCalendarEvent(userEmail, appointment) {
    try {
        const userRef = doc(db, "users", userEmail);
        const userSnap = await getDoc(userRef);
        if (!userSnap.exists()) return console.log("User config not found for calendar injection.");

        const userData = userSnap.data();
        const googleAuth = userData.integrations?.google_calendar;
        if (!googleAuth || !googleAuth.connected) return console.log("Google Calendar not connected for this user.");

        // We use Google's token endpoint to get a fresh access token using our refresh token
        let accessToken = googleAuth.access_token;
        
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                refresh_token: googleAuth.refresh_token,
                grant_type: 'refresh_token'
            })
        });

        const tokenData = await tokenResponse.json();
        if (tokenData.access_token) {
            accessToken = tokenData.access_token;
        }

        // Construct the date string for the Google Calendar event API
        // Format: YYYY-MM-DDTHH:MM:SS
        const startDateTime = `${appointment.date}T${appointment.time}:00`;
        // Default to a 30-minute duration slot
        const endDateTime = new Date(new Date(startDateTime).getTime() + 30 * 60000).toISOString().split('.')[0];

        const eventPayload = {
            summary: `Appointment with ${appointment.name}`,
            description: `Contact Info: ${appointment.contact}\nCreated automatically by Comex AI.`,
            start: { dateTime: startDateTime, timeZone: 'UTC' },
            end: { dateTime: endDateTime, timeZone: 'UTC' }
        };

        await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(eventPayload)
        });
        console.log("Successfully added event to Google Calendar!");
    } catch (err) {
        console.error("Failed to inject Google Calendar event:", err);
    }
}

// ── NEW HELPER: META WHATSAPP BUSINESS API ALERT TRIGGER ──
async function sendWhatsAppAlert(userEmail, appointment) {
    try {
        const userRef = doc(db, "users", userEmail);
        const userSnap = await getDoc(userRef);
        if (!userSnap.exists()) return;

        const userData = userSnap.data();
        const waConfig = userData.integrations?.whatsapp_business;
        if (!waConfig || !waConfig.connected) return console.log("WhatsApp integration not active.");

        const messageText = `Appointment booked on ${appointment.date} at ${appointment.time} with\n${appointment.name}\n${appointment.contact}\n\nThanks\n                  -Comex`;

        await fetch(`https://graph.facebook.com/v17.0/${waConfig.phone_number_id}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${waConfig.access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to: waConfig.phone_number_id, // Sends a business administration alert copy directly to yourself
                type: "text",
                text: { preview_url: false, body: messageText }
            })
        });
        console.log("WhatsApp alert dispatched.");
    } catch (err) {
        console.error("WhatsApp alert pipeline exception:", err);
    }
}

function getUpcomingDayDate(dayName) {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const targetIdx = days.indexOf(dayName.toLowerCase().trim());
    if (targetIdx === -1) return new Date().toISOString().split('T')[0];
    const today = new Date();
    const currentIdx = today.getDay();
    let daysToAdd = targetIdx - currentIdx;
    if (daysToAdd <= 0) daysToAdd += 7;
    today.setDate(today.getDate() + daysToAdd);
    return today.toISOString().split('T')[0];
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

    try {
        const { businessId, message, history = [] } = req.body;
        if (!businessId || !message) {
            return res.status(400).json({ success: false, answer: "Missing baseline payload constraints." });
        }

        const botRef = doc(db, "user_bots", businessId);
        const botSnap = await getDoc(botRef);
        if (!botSnap.exists()) {
            return res.status(404).json({ success: false, answer: "Target agent container profile missing." });
        }

        const botData = botSnap.data();
        const userOwnerEmail = botData.userId || businessId; // Linked owner mapping lookup pointer
        const groqApiKey = botData.groqApiKey || process.env.GROQ_API_KEY;

        if (!groqApiKey) {
            return res.status(200).json({ success: true, answer: "System configuration warning: Groq Cloud API access key is unconfigured." });
        }

        const groq = new Groq({ apiKey: groqApiKey });
        let systemContext = "You are a helpful customer scheduling executive assistant.";
        
        // Dynamic Temporal Clock Context Injection prevents the AI from choosing random dates
        const now = new Date();
        const timeContext = `\n[TEMPORAL CONTEXT]: Today is ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}. The current time is ${now.toLocaleTimeString('en-US')}.`;

        if (botData.context) {
            systemContext = `Use this context profile data parameters to answer queries: ${botData.context}` + timeContext;
        }

        const conversationalPrompt = `\n\nBooking Flow Instructions:\nIf the user wants to schedule an appointment, you MUST extract or ask for these 4 fields sequentially before finishing:\n1. Customer full name\n2. Contact details (Email or Mobile number)\n3. Target day or calendar date\n4. Preferred time slot window\n\nWhen (and ONLY when) you have gathered all 4 pieces of information, invoke your tool parameters via calling syntax or finalize by stating explicit schema JSON parameters inside double bracket block arrays like: [[BOOKING:{"name":"Name","contact":"Email/Phone","day":"DayName","time":"HH:MM"}]]`;

        systemContext += conversationalPrompt;

        const messages = [{ role: 'system', content: systemContext }];
        history.forEach(msg => {
            if (msg.role && msg.content) messages.push({ role: msg.role, content: msg.content });
        });
        messages.push({ role: 'user', content: message });

        const completion = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: messages,
            temperature: 0.4,
            max_tokens: 500
        });

        const choice = completion.choices[0];
        const replyText = choice?.message?.content || "";

        // Check if the LLM output generated our booking confirmation bracket syntax
        if (replyText.includes('[[BOOKING:')) {
            const rawMatch = replyText.split('[[BOOKING:')[1].split(']]')[0];
            const parsedData = JSON.parse(rawMatch);

            const finalizedName = parsedData.name;
            const finalizedContact = parsedData.contact;
            const finalizedDay = parsedData.day;
            const finalizedTime = parsedData.time;

            let calculatedDate = finalizedDay;
            if (!finalizedDay.includes('-')) {
                calculatedDate = getUpcomingDayDate(finalizedDay);
            }

            const appointmentData = {
                name: finalizedName,
                contact: finalizedContact,
                date: calculatedDate,
                time: finalizedTime,
                createdAt: new Date().toISOString()
            };

            // Commit record transactions into Firebase Firestore
            await addDoc(collection(db, "global_appointments"), appointmentData);
            await addDoc(collection(db, "user_bots", businessId, "appointments"), appointmentData);

            // Trigger the integrations directly using the saved credentials
            await insertGoogleCalendarEvent(userOwnerEmail, appointmentData);
            await sendWhatsAppAlert(userOwnerEmail, appointmentData);

            const customizedReply = `${finalizedName}, your appointment is successfully booked for ${finalizedTime} on ${calculatedDate}. A confirmation text has been dispatched to WhatsApp.`;
            return res.status(200).json({ success: true, answer: customizedReply, reply: customizedReply });
        }

        return res.status(200).json({ success: true, answer: replyText, reply: replyText });

    } catch (error) {
        console.error("Chat Flow Error:", error);
        return res.status(200).json({ success: true, answer: "I can help you gather details and schedule an appointment right away! Could you please provide your name and phone/email?", reply: "Error processing conversation." });
    }
}
