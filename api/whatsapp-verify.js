import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc } from 'firebase/firestore';
import { Twilio } from 'twilio';

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
// WHATSAPP VERIFICATION FLOW - STEP 1: Generate & Send Code
// ============================================================================

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { userEmail, phoneNumber, action } = req.body;

        if (!userEmail || !phoneNumber) {
            return res.status(400).json({ 
                success: false, 
                message: "Missing userEmail or phoneNumber" 
            });
        }

        // Generate a 6-digit verification code
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        
        // Store the code in Firestore with a 10-minute expiry
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

        // Send verification code via WhatsApp using Twilio
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER;

        if (!accountSid || !authToken || !twilioWhatsAppNumber) {
            return res.status(500).json({
                success: false,
                message: "WhatsApp service not configured on server"
            });
        }

        // Normalize phone number
        let toNumber = phoneNumber;
        if (!toNumber.startsWith('+')) {
            toNumber = '+' + toNumber;
        }

        // Send message via Twilio
        const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
        
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
                    Body: `Your Verification code for WhatsApp integration is ${verificationCode}.\n\nThis code will expire in 10 minutes.`
                })
            }
        );

        const whatsappData = await whatsappResponse.json();

        if (!whatsappResponse.ok) {
            console.error("WhatsApp API Error:", whatsappData);
            return res.status(500).json({
                success: false,
                message: "Failed to send WhatsApp message"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Verification code sent via WhatsApp",
            messageId: whatsappData.sid,
            verificationId: userEmail
        });

    } catch (error) {
        console.error("WhatsApp Verification Error:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
}
