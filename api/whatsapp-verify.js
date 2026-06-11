import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc } from 'firebase/firestore';

const firebaseConfig = {
    apiKey: "AIzaSyD0q99R9wn-r6e5aygL2zzg7e-Gc439ssY",
    authDomain: "cometchat-ai-platform.firebaseapp.com",
    projectId: "cometchat-ai-platform",
    storageBucket: "cometchat-ai-platform.firebasestorage.app",
    messagingSenderId: "604438924597",
    appId: "1:604438924597:web:a180d59f7f00385138507c"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ============================================================================
// WHATSAPP VERIFICATION - GENERATE & SEND CODE
// This endpoint generates a 6-digit code and sends it via Twilio WhatsApp
// ============================================================================

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { userEmail, phoneNumber } = req.body;

        console.log("[WhatsApp] Generating code for:", userEmail, "Phone:", phoneNumber);

        if (!userEmail || !phoneNumber) {
            return res.status(400).json({ 
                success: false, 
                message: "Missing userEmail or phoneNumber" 
            });
        }

        // ====================================================================
        // STEP 1: GENERATE 6-DIGIT CODE
        // ====================================================================
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        console.log("[WhatsApp] Generated code:", verificationCode);

        // ====================================================================
        // STEP 2: STORE IN FIREBASE WITH 10-MIN EXPIRY
        // ====================================================================
        const expiryTime = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        
        await setDoc(
            doc(db, "whatsapp_verifications", userEmail),
            {
                verificationCode: verificationCode,
                phoneNumber: phoneNumber,
                status: "pending",
                createdAt: new Date().toISOString(),
                expiresAt: expiryTime,
                attempts: 0
            },
            { merge: true }
        );

        console.log("[WhatsApp] Stored verification record in Firebase");

        // ====================================================================
        // STEP 3: GET TWILIO CREDENTIALS FROM ENV
        // ====================================================================
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER;

        console.log("[WhatsApp] Credentials check:", {
            accountSid: accountSid ? "✓" : "✗ MISSING",
            authToken: authToken ? "✓" : "✗ MISSING",
            twilioNumber: twilioWhatsAppNumber ? "✓" : "✗ MISSING"
        });

        if (!accountSid || !authToken || !twilioWhatsAppNumber) {
            console.error("[WhatsApp] Twilio credentials missing in environment variables");
            return res.status(500).json({
                success: false,
                message: "WhatsApp service not configured on server. Contact support.",
                debug: {
                    accountSid: !!accountSid,
                    authToken: !!authToken,
                    twilioNumber: !!twilioWhatsAppNumber
                }
            });
        }

        // ====================================================================
        // STEP 4: NORMALIZE PHONE NUMBER
        // ====================================================================
        let toNumber = phoneNumber.trim();
        
        // Remove any spaces, dashes, parens
        toNumber = toNumber.replace(/[\s\-\(\)]/g, '');
        
        // Add + if not present
        if (!toNumber.startsWith('+')) {
            toNumber = '+' + toNumber;
        }

        console.log("[WhatsApp] Normalized phone:", toNumber);

        // ====================================================================
        // STEP 5: SEND VIA TWILIO WHATSAPP
        // ====================================================================
        const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
        
        console.log("[WhatsApp] Sending code via Twilio...");

        const whatsappResponse = await fetch(
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
                    Body: `🔐 Your Comex WhatsApp Verification Code:\n\n${verificationCode}\n\nThis code will expire in 10 minutes.\n\nDo NOT share this code with anyone.`
                })
            }
        );

        const whatsappData = await whatsappResponse.json();

        console.log("[WhatsApp] Twilio Response:", {
            status: whatsappResponse.status,
            success: whatsappResponse.ok,
            messageSid: whatsappData.sid ? "✓" : "✗",
            error: whatsappData.error || whatsappData.message
        });

        if (!whatsappResponse.ok) {
            console.error("[WhatsApp] Twilio API Error:", whatsappData);
            
            // Return detailed error for debugging
            return res.status(500).json({
                success: false,
                message: whatsappData.message || "Failed to send WhatsApp message",
                error: whatsappData.error || whatsappData.code,
                debug: {
                    twilioStatus: whatsappData.status,
                    twilioErrorCode: whatsappData.code,
                    phoneNumber: toNumber,
                    timestamp: new Date().toISOString()
                }
            });
        }

        console.log("[WhatsApp] ✓ Code sent successfully! MessageId:", whatsappData.sid);

        // ====================================================================
        // STEP 6: RETURN SUCCESS
        // ====================================================================
        return res.status(200).json({
            success: true,
            message: `Verification code sent to ${phoneNumber}. Check your WhatsApp within 10 seconds.`,
            messageId: whatsappData.sid,
            verificationId: userEmail,
            debug: {
                sentTo: toNumber,
                expiresAt: expiryTime,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error("[WhatsApp] Unexpected Error:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Unknown error sending WhatsApp code",
            error: error.toString(),
            timestamp: new Date().toISOString()
        });
    }
}
