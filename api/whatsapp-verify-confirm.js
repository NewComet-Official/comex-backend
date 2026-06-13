// api/whatsapp-verify-confirm.js
// Step 2: Validate the code the user entered; save WhatsApp integration on success
import { getAdminDb } from './firebaseAdmin.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')   return res.status(405).json({ success: false });

    try {
        const { userEmail, verificationCode } = req.body;

        if (!userEmail || !verificationCode) {
            return res.status(400).json({ success: false, message: 'Missing userEmail or verificationCode.' });
        }

        const db = getAdminDb();
        const verRef  = db.collection('whatsapp_verifications').doc(userEmail);
        const verSnap = await verRef.get();

        if (!verSnap.exists) {
            return res.status(404).json({
                success: false,
                message: 'No pending verification found. Please start again.'
            });
        }

        const data = verSnap.data();

        // Check expiry
        if (Date.now() > new Date(data.expiresAt).getTime()) {
            await verRef.delete();
            return res.status(400).json({
                success: false,
                message: 'Verification code has expired. Please request a new one.'
            });
        }

        // Check attempts
        const attempts = (data.attempts || 0) + 1;
        if (data.verificationCode !== verificationCode.trim()) {
            if (attempts >= 3) {
                await verRef.delete();
                return res.status(400).json({
                    success: false,
                    message: 'Too many incorrect attempts. Please start the verification again.'
                });
            }
            await verRef.update({ attempts });
            return res.status(400).json({
                success: false,
                message: `Incorrect code. ${3 - attempts} attempt${3 - attempts === 1 ? '' : 's'} remaining.`
            });
        }

        // ✓ Code is correct — save WhatsApp integration
        const phoneNumber = data.phoneNumber;

        await db.collection('users').doc(userEmail).set(
            {
                integrations: {
                    whatsappAlerts: {
                        connected:   true,
                        phoneNumber,
                        service:     'twilio',
                        verifiedAt:  new Date().toISOString(),
                        status:      'active'
                    }
                }
            },
            { merge: true }
        );

        // Clean up verification record
        await verRef.delete();

        console.log('[WA-Confirm] ✓ WhatsApp connected for', userEmail, 'phone:', phoneNumber);

        return res.status(200).json({
            success:     true,
            message:     '✅ WhatsApp connected successfully!',
            phoneNumber
        });

    } catch (err) {
        console.error('[WA-Confirm] Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
}
