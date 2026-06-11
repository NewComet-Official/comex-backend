import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, doc, setDoc } from 'firebase/firestore';

const firebaseConfig = {
    apiKey: "AIzaSyD0q99R9wn-r6e5aygL2zzg7e-Gc439ssY",
    authDomain: "cometchat-ai-platform.firebaseapp.com",
    projectId: "cometchat-ai-platform",
    storageBucket: "cometchat-ai-platform.firebasestorage.app",
    messagingSenderId: "604438924597",
    appId: "1:604438924597:web:a180d59f7f00385138507c"
};

// ============================================================================
// CRITICAL FIX: Use Firebase Admin SDK for backend instead of Client SDK
// This avoids permission issues!
// ============================================================================

// For Vercel, we need to use environment variables for admin credentials
// Set these in Vercel: FIREBASE_SERVICE_ACCOUNT_JSON (base64 encoded)

let adminDb = null;

function initializeFirebaseAdmin() {
    try {
        // Try to get admin instance first
        if (adminDb) return adminDb;

        // Check if we're in Node.js environment with admin SDK
        const admin = require('firebase-admin');
        
        if (!admin.apps.length) {
            // Decode service account from env variable
            const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
            if (!serviceAccountBase64) {
                console.warn("FIREBASE_SERVICE_ACCOUNT_JSON not set, falling back to client SDK");
                return null;
            }

            const serviceAccount = JSON.parse(
                Buffer.from(serviceAccountBase64, 'base64').toString('utf-8')
            );

            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: `https://${firebaseConfig.projectId}.firebaseio.com`
            });
        }

        adminDb = admin.firestore();
        return adminDb;
    } catch (error) {
        console.warn("Admin SDK not available, using client SDK:", error.message);
        return null;
    }
}

// Fallback to client SDK
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(app);

export default async function handler(req, res) {
    const { code, state, error } = req.query;

    console.log("[OAuth] Received callback:", { code: code ? "***" : null, state: state ? "***" : null, error });

    if (error) {
        console.error("[OAuth] User denied permission:", error);
        return res.status(400).send(`OAuth Error: ${error}`);
    }

    if (!code || !state) {
        console.error("[OAuth] Missing code or state parameters");
        return res.status(400).send("Missing code or state parameters.");
    }

    let email = "";
    let origin = "";

    try {
        // Decode state parameter (JSON containing email and original site origin)
        const decodedState = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
        email = decodedState.email;
        origin = decodedState.origin;
        
        console.log("[OAuth] Decoded state:", { email, origin: origin?.substring(0, 30) + "..." });
    } catch (e) {
        // Fallback if state was not base64 encoded JSON
        email = state;
        origin = `https://${req.headers.host}`;
        console.warn("[OAuth] State decode failed, using fallback");
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.error("[OAuth] Missing Google credentials in env vars");
        return res.status(500).send("Server configuration missing client credentials.");
    }

    const redirectUri = process.env.GOOGLE_REDIRECT_URI || `https://${req.headers.host}/api/oauth/callback`;

    try {
        console.log("[OAuth] Exchanging code for tokens...");

        // Exchange code for tokens
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code'
            })
        });

        const tokens = await tokenResponse.json();

        if (tokens.error) {
            console.error("[OAuth] Token exchange failed:", tokens.error);
            return res.status(400).send(`Token Exchange Failed: ${tokens.error_description || tokens.error}`);
        }

        console.log("[OAuth] Tokens received, saving to Firebase...");

        // Calculate absolute token expiry date
        const expiryDate = tokens.expires_in 
            ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() 
            : new Date(Date.now() + 3500 * 1000).toISOString();

        // ============================================================================
        // TRY ADMIN SDK FIRST, FALLBACK TO CLIENT SDK
        // ============================================================================
        let adminDbInstance = initializeFirebaseAdmin();
        let saveSuccess = false;

        if (adminDbInstance) {
            try {
                console.log("[OAuth] Using Admin SDK to save tokens...");
                
                const calendarData = {
                    connected: true,
                    access_token: tokens.access_token,
                    expiry_date: expiryDate
                };

                if (tokens.refresh_token) {
                    calendarData.refresh_token = tokens.refresh_token;
                }

                await adminDbInstance.collection('users').doc(email).set({
                    integrations: {
                        google_calendar: calendarData
                    }
                }, { merge: true });

                saveSuccess = true;
                console.log("[OAuth] ✓ Tokens saved with Admin SDK");
            } catch (adminError) {
                console.warn("[OAuth] Admin SDK save failed, trying client SDK:", adminError.message);
            }
        }

        // Fallback to client SDK if admin fails
        if (!saveSuccess) {
            try {
                console.log("[OAuth] Using Client SDK to save tokens...");
                
                const userRef = doc(db, "users", email);
                const calendarData = {
                    connected: true,
                    access_token: tokens.access_token,
                    expiry_date: expiryDate
                };

                if (tokens.refresh_token) {
                    calendarData.refresh_token = tokens.refresh_token;
                }

                await setDoc(userRef, {
                    integrations: {
                        google_calendar: calendarData
                    }
                }, { merge: true });

                saveSuccess = true;
                console.log("[OAuth] ✓ Tokens saved with Client SDK");
            } catch (clientError) {
                console.error("[OAuth] Client SDK save also failed:", clientError);
                
                // If both fail, give helpful error
                if (clientError.code === 'permission-denied') {
                    console.error("[OAuth] PERMISSION DENIED - Check Firebase Rules:");
                    console.error("  1. Go to Firebase Console → Firestore → Rules");
                    console.error("  2. Add rule: match /users/{userId} { allow write: if true; }");
                    console.error("  3. Publish rules");
                    return res.status(500).send("Database permission error. Please contact support with error: PERMISSION_DENIED");
                }
                
                throw clientError;
            }
        }

        // ✅ Success - redirect back to integrations page
        const cleanOrigin = origin.endsWith('/') ? origin.slice(0, -1) : origin;
        const redirectUrl = `${cleanOrigin}/#integrationsView?calendar_connected=true`;
        
        console.log("[OAuth] ✓ Redirecting to:", redirectUrl);
        return res.redirect(redirectUrl);

    } catch (err) {
        console.error("[OAuth] Callback Handler Error:", err);
        
        // Return user to integrations page with error
        const cleanOrigin = origin.endsWith('/') ? origin.slice(0, -1) : origin;
        const errorMessage = encodeURIComponent(err.message || "Unknown error");
        const errorUrl = `${cleanOrigin}/#integrationsView?calendar_error=${errorMessage}`;
        
        return res.redirect(errorUrl);
    }
}
