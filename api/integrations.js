import { getDoc, doc, updateDoc } from 'firebase/firestore';

// ============================================================================
// GOOGLE CALENDAR INTEGRATION - FIXED FOR PROPER DATETIME
// ============================================================================

export async function createGoogleCalendarEvent(db, userEmail, appointmentData) {
    try {
        const userDocRef = doc(db, "users", userEmail);
        const userDoc = await getDoc(userDocRef);
        
        if (!userDoc.exists()) {
            console.error("User profile not found for email:", userEmail);
            return { success: false, error: "User profile not found" };
        }

        const userData = userDoc.data();
        const googleAuth = userData?.integrations?.google_calendar;
        
        if (!googleAuth || !googleAuth.connected) {
            console.error("Google Calendar not connected for user:", userEmail);
            return { success: false, error: "Google Calendar not connected" };
        }

        let accessToken = googleAuth.access_token;
        
        // Refresh token if expired
        if (googleAuth.refresh_token && googleAuth.expiry_date) {
            const expiryTime = new Date(googleAuth.expiry_date).getTime();
            if (expiryTime < Date.now()) {
                try {
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
                } catch (err) {
                    console.error("Token refresh failed:", err);
                }
            }
        }

        // ============================================================================
        // FIXED: PROPER DATETIME PARSING
        // ============================================================================
        let eventDate, endDate;

        // Use scheduledDateTime if available (full ISO format), otherwise construct from date+time
        if (appointmentData.scheduledDateTime) {
            // scheduledDateTime format: "2026-06-15T14:00:00"
            eventDate = new Date(appointmentData.scheduledDateTime);
        } else {
            // Fallback: combine scheduledDate + parse time from scheduledTime
            const timeMatch = appointmentData.scheduledTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)/i);
            let hours = 9, minutes = 0;

            if (timeMatch) {
                hours = parseInt(timeMatch[1], 10);
                minutes = parseInt(timeMatch[2], 10);
                const period = timeMatch[3].toUpperCase();

                if (period === "PM" && hours !== 12) hours += 12;
                if (period === "AM" && hours === 12) hours = 0;
            }

            eventDate = new Date(`${appointmentData.scheduledDate}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`);
        }

        // Ensure valid date
        if (isNaN(eventDate.getTime())) {
            console.error("Invalid event date:", appointmentData.scheduledDate, appointmentData.scheduledTime);
            return { success: false, error: "Invalid appointment date/time" };
        }

        // 30-minute duration
        endDate = new Date(eventDate.getTime() + 30 * 60000);

        console.log("Creating Google Calendar event:");
        console.log("  Start:", eventDate.toISOString());
        console.log("  End:", endDate.toISOString());
        console.log("  Customer:", appointmentData.customerName);

        // Create calendar event
        const eventResponse = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                summary: `Appointment with ${appointmentData.customerName}`,
                description: `Contact: ${appointmentData.contactInfo}\nBooked via Comex AI\nConversation: ${appointmentData.conversationId}`,
                start: {
                    dateTime: eventDate.toISOString(),
                    timeZone: 'UTC'
                },
                end: {
                    dateTime: endDate.toISOString(),
                    timeZone: 'UTC'
                },
                reminders: {
                    useDefault: true
                }
            })
        });

        const eventData = await eventResponse.json();
        
        if (!eventResponse.ok) {
            console.error("Google Calendar API error:", eventData);
            return { success: false, error: eventData.error?.message || "Failed to create event" };
        }

        console.log("Calendar event created successfully:", eventData.id);

        return {
            success: true,
            eventId: eventData.id,
            eventLink: eventData.htmlLink,
            message: "Calendar event created"
        };

    } catch (error) {
        console.error("Google Calendar Error:", error);
        return {
            success: false,
            error: error.message || "Failed to create calendar event"
        };
    }
}

// ============================================================================
// WHATSAPP INTEGRATION (via Twilio)
// ============================================================================

export async function sendWhatsAppNotification(appointmentData) {
    try {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER;

        if (!accountSid || !authToken || !twilioWhatsAppNumber) {
            console.log("WhatsApp not fully configured - skipping notification");
            return { success: false, error: "Twilio credentials not configured" };
        }

        let toNumber = appointmentData.contactInfo;
        if (!toNumber.startsWith('+')) {
            toNumber = '+' + toNumber;
        }

        const message = `✅ Appointment Confirmed\n\nDate: ${appointmentData.scheduledDate}\nTime: ${appointmentData.scheduledTime}\n\nWith: ${appointmentData.customerName}\n\nThanks!\n- Comex`;

        const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
        
        const response = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    From: `whatsapp:${twilioWhatsAppNumber}`,
                    To: `whatsapp:${toNumber}`,
                    Body: message
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            console.error("WhatsApp API error:", data);
            return { success: false, error: data.message || "Failed to send WhatsApp message" };
        }

        console.log("WhatsApp message sent:", data.sid);

        return {
            success: true,
            messageId: data.sid,
            message: "WhatsApp notification sent"
        };

    } catch (error) {
        console.error("WhatsApp Error:", error);
        return {
            success: false,
            error: error.message || "Failed to send WhatsApp message"
        };
    }
}

// ============================================================================
// AVAILABILITY CHECKING (Calendar Conflict Detection)
// ============================================================================

export async function checkCalendarAvailability(db, userEmail, date, timeSlot) {
    try {
        const userDocRef = doc(db, "users", userEmail);
        const userDoc = await getDoc(userDocRef);
        const userData = userDoc.data();
        const googleAuth = userData?.integrations?.google_calendar;
        
        if (!googleAuth || !googleAuth.connected) {
            return { available: true, reason: "Calendar not synced" };
        }

        let accessToken = googleAuth.access_token;

        // Parse the time properly
        const timeMatch = timeSlot.match(/(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)/i);
        let hours = 9, minutes = 0;

        if (timeMatch) {
            hours = parseInt(timeMatch[1], 10);
            minutes = parseInt(timeMatch[2], 10);
            const period = timeMatch[3].toUpperCase();

            if (period === "PM" && hours !== 12) hours += 12;
            if (period === "AM" && hours === 12) hours = 0;
        }

        const eventDate = new Date(`${date}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`);
        const endDate = new Date(eventDate.getTime() + 60 * 60000); // 1 hour

        console.log("Checking availability:", eventDate.toISOString(), "-", endDate.toISOString());

        const response = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
            `timeMin=${eventDate.toISOString()}&` +
            `timeMax=${endDate.toISOString()}&` +
            `singleEvents=true`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const data = await response.json();
        const isBooked = data.items && data.items.length > 0;
        
        console.log("Availability check result:", isBooked ? "BOOKED" : "AVAILABLE", `(${data.items?.length || 0} conflicts)`);
        
        return {
            available: !isBooked,
            bookedEvents: isBooked ? data.items : [],
            suggestedTimes: isBooked ? generateSuggestedTimes(eventDate) : null
        };

    } catch (error) {
        console.error("Availability Check Error:", error);
        return { available: true, reason: "Could not verify - proceeding with booking" };
    }
}

function generateSuggestedTimes(baseDate) {
    const suggestions = [];
    let nextSlot = new Date(baseDate);
    
    for (let i = 0; i < 3; i++) {
        nextSlot.setHours(nextSlot.getHours() + 1);
        
        if (nextSlot.getHours() >= 9 && nextSlot.getHours() < 17) {
            suggestions.push({
                date: nextSlot.toLocaleDateString(),
                time: nextSlot.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
            });
        }
    }
    
    return suggestions;
}
