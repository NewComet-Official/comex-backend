// api/integrations.js
import { getAdminDb } from './firebaseAdmin.js';

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE CALENDAR — create calendar event
// ─────────────────────────────────────────────────────────────────────────────
export async function createGoogleCalendarEvent(userEmail, appointmentData) {
    try {
        const db      = getAdminDb();
        const userDoc = await db.collection('users').doc(userEmail).get();

        if (!userDoc.exists) return { success: false, error: 'User not found' };

        const googleAuth = userDoc.data()?.integrations?.google_calendar;
        if (!googleAuth?.connected) return { success: false, error: 'Google Calendar not connected' };

        let accessToken = googleAuth.access_token;

        // Refresh token if expired
        if (googleAuth.refresh_token) {
            const expiry = new Date(googleAuth.expiry_date).getTime();
            if (expiry < Date.now()) {
                const tr = await fetch('https://oauth2.googleapis.com/token', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        client_id:     process.env.GOOGLE_CLIENT_ID,
                        client_secret: process.env.GOOGLE_CLIENT_SECRET,
                        refresh_token: googleAuth.refresh_token,
                        grant_type:    'refresh_token'
                    })
                });
                const td = await tr.json();
                if (td.access_token) {
                    accessToken = td.access_token;
                    await db.collection('users').doc(userEmail).update({
                        'integrations.google_calendar.access_token': td.access_token,
                        'integrations.google_calendar.expiry_date':
                            new Date(Date.now() + td.expires_in * 1000).toISOString()
                    });
                }
            }
        }

        // Parse the appointment time into start/end datetimes
        const timeMatch = appointmentData.scheduledTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        let hours = 9, minutes = 0;
        if (timeMatch) {
            hours   = parseInt(timeMatch[1], 10);
            minutes = parseInt(timeMatch[2], 10);
            const pm = timeMatch[3].toUpperCase() === 'PM';
            if (pm && hours !== 12) hours += 12;
            if (!pm && hours === 12) hours = 0;
        }

        const startISO = `${appointmentData.scheduledDate}T${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:00`;
        const startDt  = new Date(startISO);
        if (isNaN(startDt.getTime())) return { success: false, error: 'Invalid date/time for calendar event' };
        const endDt    = new Date(startDt.getTime() + 30 * 60000); // 30-minute slot

        const evRes = await fetch(
            'https://www.googleapis.com/calendar/v3/calendars/primary/events',
            {
                method:  'POST',
                headers: {
                    Authorization:  `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    summary:     `Appointment: ${appointmentData.customerName}`,
                    description: `Contact: ${appointmentData.contactInfo}\nBooked via Comex AI`,
                    start: { dateTime: startDt.toISOString(), timeZone: 'UTC' },
                    end:   { dateTime: endDt.toISOString(),   timeZone: 'UTC' },
                    reminders: { useDefault: true }
                })
            }
        );
        const evData = await evRes.json();
        if (!evRes.ok) return { success: false, error: evData.error?.message || 'Calendar API error' };

        console.log('[Calendar] ✓ Event created:', evData.id);
        return { success: true, eventId: evData.id, eventLink: evData.htmlLink };

    } catch (err) {
        console.error('[Calendar] Error:', err);
        return { success: false, error: err.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP — send appointment confirmation to BUSINESS OWNER via Twilio
//
// Message format (exact):
//   Appointment booked on {{Date}} at {{time}}
//   with {{name}}
//   {{email}}
//
//   Thanks
//                  -Comex AI platform
// ─────────────────────────────────────────────────────────────────────────────
export async function sendWhatsAppNotification(userEmail, appointmentData) {
    try {
        const db      = getAdminDb();
        const userDoc = await db.collection('users').doc(userEmail).get();
        if (!userDoc.exists) return { success: false, error: 'User not found' };

        const waAuth = userDoc.data()?.integrations?.whatsappAlerts;
        if (!waAuth?.connected) return { success: false, error: 'WhatsApp not connected' };

        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken  = process.env.TWILIO_AUTH_TOKEN;
        const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER; // Twilio sandbox or approved number

        if (!accountSid || !authToken || !fromNumber) {
            return { success: false, error: 'Twilio credentials not set in env vars' };
        }

        let toNumber = waAuth.phoneNumber.replace(/[\s\-\(\)]/g, '');
        if (!toNumber.startsWith('+')) toNumber = '+' + toNumber;

        const messageBody =
            `Appointment booked on ${appointmentData.scheduledDate} at ${appointmentData.scheduledTime}\n` +
            `with ${appointmentData.customerName}\n` +
            `${appointmentData.contactInfo}\n\n` +
            `Thanks\n` +
            `               -Comex AI platform`;

        const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

        const twRes = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
            {
                method:  'POST',
                headers: {
                    Authorization:  `Basic ${basicAuth}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    From: `whatsapp:${fromNumber}`,
                    To:   `whatsapp:${toNumber}`,
                    Body: messageBody
                })
            }
        );
        const twData = await twRes.json();

        if (!twRes.ok) {
            console.error('[WhatsApp] Twilio error:', twData);
            return { success: false, error: twData.message };
        }

        console.log('[WhatsApp] ✓ Appointment notification sent | SID:', twData.sid);
        return { success: true, messageId: twData.sid };

    } catch (err) {
        console.error('[WhatsApp] Error:', err);
        return { success: false, error: err.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR AVAILABILITY CHECK
// ─────────────────────────────────────────────────────────────────────────────
export async function checkCalendarAvailability(userEmail, date, timeSlot) {
    try {
        const db      = getAdminDb();
        const userDoc = await db.collection('users').doc(userEmail).get();
        if (!userDoc.exists) return { available: true };

        const googleAuth = userDoc.data()?.integrations?.google_calendar;
        if (!googleAuth?.connected) return { available: true };

        const timeMatch = timeSlot.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        let hours = 9, minutes = 0;
        if (timeMatch) {
            hours   = parseInt(timeMatch[1], 10);
            minutes = parseInt(timeMatch[2], 10);
            const pm = timeMatch[3].toUpperCase() === 'PM';
            if (pm && hours !== 12) hours += 12;
            if (!pm && hours === 12) hours = 0;
        }

        const startISO = `${date}T${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:00`;
        const startDt  = new Date(startISO);
        const endDt    = new Date(startDt.getTime() + 60 * 60000);

        const qRes = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/primary/events` +
            `?timeMin=${startDt.toISOString()}&timeMax=${endDt.toISOString()}&singleEvents=true`,
            { headers: { Authorization: `Bearer ${googleAuth.access_token}` } }
        );
        const qData  = await qRes.json();
        const booked = qData.items?.length > 0;

        return {
            available:      !booked,
            suggestedTimes: booked ? generateSlots(startDt) : null
        };
    } catch (err) {
        console.error('[Availability] Error:', err);
        return { available: true };
    }
}

function generateSlots(base) {
    const slots = [];
    const d = new Date(base);
    for (let i = 1; i <= 3; i++) {
        d.setHours(d.getHours() + 1);
        if (d.getHours() >= 9 && d.getHours() < 17) {
            slots.push({
                date: d.toLocaleDateString(),
                time: d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
            });
        }
    }
    return slots;
}
