// api/whatsapp-verify.js
// ─────────────────────────────────────────────────────────────────────────────
// Step 1 of WhatsApp verification:
//   • Generate a random 6-digit code
//   • Store it in Firestore (via Admin SDK) under whatsapp_verifications/{email}
//   • Send it FROM your Twilio number TO the user's number on WhatsApp
// ─────────────────────────────────────────────────────────────────────────────
import { getAdminDb } from './firebaseAdmin.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { userEmail, phoneNumber } = req.body;

        if (!userEmail || !phoneNumber) {
            return res.status(400).json({ success: false, message: 'Missing userEmail or phoneNumber.' });
        }

        // ── 1. Generate code ──────────────────────────────────────────────────
        const code      = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

        // ── 2. Persist in Firestore (Admin SDK, no rules issue) ───────────────
        const db = getAdminDb();
        await db.collection('whatsapp_verifications').doc(userEmail).set({
            verificationCode: code,
            phoneNumber,
            status:    'pending',
            createdAt: new Date().toISOString(),
            expiresAt,
            attempts:  0
        });

        // ── 3. Validate Twilio credentials ────────────────────────────────────
        const accountSid      = process.env.TWILIO_ACCOUNT_SID;
        const authToken       = process.env.TWILIO_AUTH_TOKEN;
        const twilioWaNumber  = process.env.TWILIO_WHATSAPP_NUMBER; // e.g. +14155238886

        if (!accountSid || !authToken || !twilioWaNumber) {
            console.error('[WA-Verify] Missing Twilio env vars');
            return res.status(500).json({
                success: false,
                message: 'WhatsApp service not configured on server. Check Twilio env vars.'
            });
        }

        // ── 4. Normalize the destination number ───────────────────────────────
        let toNumber = phoneNumber.replace(/[\s\-\(\)]/g, '');
        if (!toNumber.startsWith('+')) toNumber = '+' + toNumber;

        // ── 5. Send via Twilio WhatsApp ───────────────────────────────────────
        const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

        const twilioRes = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Basic ${basicAuth}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    From: `whatsapp:${twilioWaNumber}`,
                    To:   `whatsapp:${toNumber}`,
                    Body: `Your Verification code for WhatsApp integration is ${code}.`
                })
            }
        );

        const twilioData = await twilioRes.json();

        if (!twilioRes.ok) {
            console.error('[WA-Verify] Twilio error:', twilioData);
            return res.status(500).json({
                success: false,
                message: twilioData.message || 'Failed to send WhatsApp message.',
                twilioCode: twilioData.code
            });
        }

        console.log('[WA-Verify] ✓ Code sent to', toNumber, '| SID:', twilioData.sid);

        return res.status(200).json({
            success:   true,
            message:   `Verification code sent to WhatsApp ${toNumber}.`,
            messageId: twilioData.sid
        });

    } catch (err) {
        console.error('[WA-Verify] Unexpected error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
}
