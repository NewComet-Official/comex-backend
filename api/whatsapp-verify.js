// api/whatsapp-verify.js
// Step 1: Generate 6-digit code and send it to the user's WhatsApp via Twilio
import { getAdminDb } from './firebaseAdmin.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')   return res.status(405).json({ success: false });

    try {
        const { userEmail, phoneNumber } = req.body;

        if (!userEmail || !phoneNumber) {
            return res.status(400).json({ success: false, message: 'Missing userEmail or phoneNumber.' });
        }

        // Validate Twilio credentials
        const accountSid     = process.env.TWILIO_ACCOUNT_SID;
        const authToken      = process.env.TWILIO_AUTH_TOKEN;
        const twilioWaNumber = process.env.TWILIO_WHATSAPP_NUMBER; // e.g. +14155238886 (Twilio sandbox)

        if (!accountSid || !authToken || !twilioWaNumber) {
            return res.status(500).json({
                success: false,
                message: 'WhatsApp service not configured. Please set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_WHATSAPP_NUMBER in Vercel environment variables.'
            });
        }

        // Generate 6-digit code
        const code      = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

        // Save pending verification to Firestore
        const db = getAdminDb();
        await db.collection('whatsapp_verifications').doc(userEmail).set({
            verificationCode: code,
            phoneNumber,
            status:    'pending',
            createdAt: new Date().toISOString(),
            expiresAt,
            attempts:  0
        });

        // Normalize phone number to E.164 format
        let toNumber = phoneNumber.replace(/[\s\-\(\)]/g, '');
        if (!toNumber.startsWith('+')) toNumber = '+' + toNumber;

        // Send verification code via Twilio WhatsApp
        const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

        const twilioRes = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
            {
                method:  'POST',
                headers: {
                    Authorization:  `Basic ${basicAuth}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    From: `whatsapp:${twilioWaNumber}`,
                    To:   `whatsapp:${toNumber}`,
                    Body: `Your Comex AI verification code is: *${code}*\n\nThis code expires in 10 minutes. Do not share it with anyone.`
                })
            }
        );

        const twilioData = await twilioRes.json();

        if (!twilioRes.ok) {
            console.error('[WA-Verify] Twilio error:', twilioData);

            // Twilio error 63016 = number not opted into sandbox
            if (twilioData.code === 63016) {
                return res.status(400).json({
                    success: false,
                    code:    'NOT_OPTED_IN',
                    message: `Your WhatsApp number hasn't joined the Twilio sandbox yet. Please send the message "join <sandbox-keyword>" to the Twilio WhatsApp number first. Check your Twilio console for the exact keyword.`
                });
            }

            return res.status(500).json({
                success: false,
                message: twilioData.message || 'Failed to send WhatsApp message.',
                twilioCode: twilioData.code
            });
        }

        console.log('[WA-Verify] ✓ Code sent to', toNumber, '| SID:', twilioData.sid);

        return res.status(200).json({
            success:   true,
            message:   `Verification code sent to WhatsApp ${toNumber}. Check your WhatsApp!`,
            messageId: twilioData.sid
        });

    } catch (err) {
        console.error('[WA-Verify] Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
}
