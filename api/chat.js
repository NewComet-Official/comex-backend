// api/chat.js
import Groq from 'groq-sdk';
import { getAdminDb } from './firebaseAdmin.js';
import {
    createGoogleCalendarEvent,
    sendWhatsAppNotification,
    checkCalendarAvailability
} from './integrations.js';

const APPOINTMENT_PROMPT = `
You can book appointments when the user explicitly asks for one.

RULES:
- Only collect booking info if the user clearly asks to book/schedule an appointment.
- Collect naturally — never fire multiple questions at once.
- Required fields: name, contact (email or phone), preferred day, preferred time.
- Read the full conversation history first. Never ask for info already given.
- Once you have all 4 fields confirmed, call appointmentBooking immediately.

When calling appointmentBooking:
  userName:        full name (REQUIRED)
  contactInfo:     email or phone (REQUIRED)
  appointmentDay:  day name e.g. "Monday" (REQUIRED)
  appointmentTime: 12-hour format e.g. "2:00 PM" (REQUIRED)
`;

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')   return res.status(405).json({ message: 'Method Not Allowed' });

    try {
        const { businessId, question, message, history = [], conversationId: incomingId } = req.body;
        const promptText = question || message;
        if (!businessId || !promptText) return res.status(400).json({ success: false, answer: 'Missing fields.' });
        if (!process.env.GROQ_API_KEY)  return res.status(500).json({ success: false, answer: 'Server config error.' });

        const conversationId = incomingId || `conv-${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
        const db = getAdminDb();

        // ── Load bot data ─────────────────────────────────────────────────────
        const botSnap = await db.collection('user_bots').doc(businessId).get();
        let systemContext = 'You are a helpful, friendly customer service assistant.';
        let ownerEmail    = 'unknown';
        let botName       = 'Agent';
        let integrations  = {};

        if (botSnap.exists) {
            const bot      = botSnap.data();
            const knowledge = bot.knowledgeContext || {};
            ownerEmail     = bot.owner   || 'unknown';
            botName        = bot.name    || 'Agent';
            integrations   = bot.integrations || {};

            if (knowledge.systemPrompt) {
                systemContext = knowledge.systemPrompt;
            } else if (bot.context) {
                systemContext = `You are a helpful assistant. Answer using:\n\n${bot.context}`;
            }
            if (knowledge.fileContents) systemContext += `\n\n[FILES]:\n${knowledge.fileContents}`;
        }

        systemContext += `\n\n${APPOINTMENT_PROMPT}`;

        // ── Build Groq messages ───────────────────────────────────────────────
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const msgs = [
            { role: 'system', content: systemContext },
            ...( Array.isArray(history) ? history : [] ),
            { role: 'user', content: promptText }
        ];

        const completion = await groq.chat.completions.create({
            model:       'llama-3.1-8b-instant',
            messages:    msgs,
            tools: [{
                type: 'function',
                function: {
                    name:        'appointmentBooking',
                    description: 'Book an appointment once name, contact, day, and time are all known.',
                    parameters: {
                        type: 'object',
                        properties: {
                            userName:        { type: 'string', description: 'Customer full name' },
                            contactInfo:     { type: 'string', description: 'Email or phone number' },
                            appointmentDay:  { type: 'string', description: 'Day name (Monday, Tuesday…)' },
                            appointmentTime: { type: 'string', description: '12-hour time e.g. 2:00 PM' }
                        },
                        required: ['userName', 'contactInfo', 'appointmentDay', 'appointmentTime']
                    }
                }
            }],
            tool_choice: 'auto',
            temperature: 0.5,
            max_tokens:  1024
        });

        const choice = completion.choices[0]?.message;

        // ── Handle tool call ──────────────────────────────────────────────────
        if (choice?.tool_calls?.length > 0 && choice.tool_calls[0].function.name === 'appointmentBooking') {
            const args = JSON.parse(choice.tool_calls[0].function.arguments);

            if (!args.userName || !args.contactInfo || !args.appointmentDay || !args.appointmentTime) {
                return res.json({ success: true, answer: 'I still need a few details — could you share your name, contact, preferred day, and time?' });
            }

            const name    = args.userName.trim();
            const contact = args.contactInfo.trim();
            const day     = args.appointmentDay.trim();
            const time    = args.appointmentTime.trim();

            // ── Resolve date ──────────────────────────────────────────────────
            const dateISO = args.appointmentDate || resolveDay(day);
            const timeStr = to24h(time);
            const dt      = `${dateISO}T${timeStr}`;

            // ── Availability check ────────────────────────────────────────────
            if (integrations.googleCalendar?.connected) {
                const avail = await checkCalendarAvailability(ownerEmail, dateISO, time);
                if (!avail.available && avail.suggestedTimes?.length) {
                    return res.json({
                        success: true,
                        answer: `That slot is taken. Alternatives:\n${avail.suggestedTimes.map((s,i)=>`${i+1}. ${s.time} on ${s.date}`).join('\n')}\n\nWhich works for you?`
                    });
                }
            }

            // ── Save appointment ──────────────────────────────────────────────
            const apptData = {
                businessId, botName, owner: ownerEmail, conversationId,
                customerName:    name,
                contactInfo:     contact,
                appointmentDay:  day,
                appointmentTime: time,
                scheduledDate:   dateISO,
                scheduledTime:   time,
                scheduledDateTime: dt,
                status:    'confirmed',
                createdAt: new Date().toISOString(),
                googleCalendarEventId: null,
                whatsappMessageId:     null
            };

            const apptRef = await db.collection('appointments').add(apptData);
            await db.collection('user_bots').doc(businessId).collection('appointments').add(apptData);

            // ── Google Calendar ───────────────────────────────────────────────
            let calResult = { success: false };
            if (integrations.googleCalendar?.connected) {
                calResult = await createGoogleCalendarEvent(ownerEmail, apptData);
                if (calResult.success) {
                    await apptRef.update({
                        googleCalendarEventId: calResult.eventId,
                        googleCalendarLink:    calResult.eventLink
                    });
                }
            }

            // ── WhatsApp notification ─────────────────────────────────────────
            let waResult = { success: false };
            if (integrations.whatsappAlerts?.connected) {
                waResult = await sendWhatsAppNotification(ownerEmail, apptData);
                if (waResult.success) await apptRef.update({ whatsappMessageId: waResult.messageId });
            }

            // ── Confirmation reply ────────────────────────────────────────────
            let reply = `✅ Appointment Confirmed!\n\n📅 Date: ${dateISO}\n🕐 Time: ${time}\n👤 Name: ${name}\n📧 Contact: ${contact}`;
            if (calResult.success) reply += `\n\n✓ Added to Google Calendar`;
            if (waResult.success)  reply += `\n✓ Confirmation sent via WhatsApp`;
            reply += `\n\nIs there anything else I can help you with?`;

            return res.json({ success: true, answer: reply, appointmentId: apptRef.id });
        }

        // ── Plain text reply ──────────────────────────────────────────────────
        const replyText = choice?.content || 'How can I help you today?';

        // ── Save chat log ─────────────────────────────────────────────────────
        try {
            await db.collection('user_bots').doc(businessId).collection('chats').add({
                conversationId,
                question:        promptText,
                answer:          replyText,
                isGenuineQuery:  true,
                isLeadCaptured:  false,
                createdAt:       new Date().toISOString()
            });
        } catch (logErr) {
            console.warn('[Chat] Could not save chat log:', logErr.message);
        }

        return res.json({ success: true, answer: replyText });

    } catch (err) {
        console.error('[Chat] Error:', err);
        return res.status(500).json({ success: false, answer: 'Sorry, something went wrong. Please try again.', error: err.message });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function resolveDay(dayName) {
    const days  = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const today = new Date();
    const idx   = days.indexOf(dayName.toLowerCase().trim());
    if (idx === -1) return today.toISOString().split('T')[0];
    let diff = idx - today.getDay();
    if (diff <= 0) diff += 7;
    const result = new Date(today);
    result.setDate(today.getDate() + diff);
    return result.toISOString().split('T')[0];
}

function to24h(timeStr) {
    const m = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!m) return '09:00:00';
    let h = parseInt(m[1], 10);
    const min = m[2];
    const pm  = m[3].toUpperCase() === 'PM';
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    return `${String(h).padStart(2,'0')}:${min}:00`;
}
