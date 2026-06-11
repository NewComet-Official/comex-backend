import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';

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
// WHATSAPP VERIFICATION FLOW - STEP 2: Verify Code & Complete Connection
// ============================================================================

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { userEmail, verificationCode } = req.body;

        if (!userEmail || !verificationCode) {
            return res.status(400).json({
                success: false,
                message: "Missing userEmail or verificationCode"
            });
        }

        // Retrieve verification record from Firestore
        const verificationRef = doc(db, "whatsapp_verifications", userEmail);
        const verificationSnap = await getDoc(verificationRef);

        if (!verificationSnap.exists()) {
            return res.status(404).json({
                success: false,
                message: "No verification request found. Please start the WhatsApp connection process again."
            });
        }

        const verificationData = verificationSnap.data();

        // Check if code has expired
        const expiryTime = new Date(verificationData.expiresAt).getTime();
        if (Date.now() > expiryTime) {
            await deleteDoc(verificationRef);
            return res.status(400).json({
                success: false,
                message: "Verification code has expired. Please try again."
            });
        }

        // Check if code matches
        if (verificationData.verificationCode !== verificationCode.trim()) {
            // Increment attempts
            const attempts = (verificationData.attempts || 0) + 1;
            
            if (attempts >= 3) {
                await deleteDoc(verificationRef);
                return res.status(400).json({
                    success: false,
                    message: "Too many failed attempts. Please restart the connection process."
                });
            }

            await updateDoc(verificationRef, { attempts });
            return res.status(400).json({
                success: false,
                message: `Incorrect code. ${3 - attempts} attempts remaining.`
            });
        }

        // Code is correct! Save WhatsApp connection to user document
        const phoneNumber = verificationData.phoneNumber;
        
        await setDoc(
            doc(db, "users", userEmail),
            {
                integrations: {
                    whatsappAlerts: {
                        connected: true,
                        phoneNumber: phoneNumber,
                        service: "twilio",
                        verifiedAt: new Date().toISOString(),
                        status: "active"
                    }
                }
            },
            { merge: true }
        );

        // Clean up verification record
        await deleteDoc(verificationRef);

        return res.status(200).json({
            success: true,
            message: "WhatsApp connection verified and activated!",
            phoneNumber: phoneNumber
        });

    } catch (error) {
        console.error("WhatsApp Verification Confirmation Error:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
}
