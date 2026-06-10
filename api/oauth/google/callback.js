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

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(app);

export default async function handler(req, res) {
    const { code, state, error } = req.query;

    if (error) {
        return res.status(400).send(`OAuth Error: ${error}`);
    }

    if (!code || !state) {
        return res.status(400).send("Missing code or state parameters.");
    }

    let email = "";
    let origin = "";

    try {
        // Decode state parameter (JSON containing email and original site origin)
        const decodedState = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
        email = decodedState.email;
        origin = decodedState.origin;
    } catch (e) {
        // Fallback if state was not base64 encoded JSON
        email = state;
        origin = `https://${req.headers.host}`;
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        return res.status(500).send("Server configuration missing client credentials.");
    }

    const redirectUri = process.env.GOOGLE_REDIRECT_URI || `https://${req.headers.host}/api/oauth/callback`;

    try {
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
            return res.status(400).send(`Token Exchange Failed: ${tokens.error_description || tokens.error}`);
        }

        // Calculate absolute token expiry date
        const expiryDate = tokens.expires_in 
            ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() 
            : new Date(Date.now() + 3500 * 1000).toISOString();

        // Save tokens to Firestore
        const userRef = doc(db, "users", email);
        const calendarData = {
            connected: true,
            access_token: tokens.access_token,
            expiry_date: expiryDate
        };

        // If Google returned a refresh token (typically on the first consent prompt), save it
        if (tokens.refresh_token) {
            calendarData.refresh_token = tokens.refresh_token;
        }

        await setDoc(userRef, {
            integrations: {
                google_calendar: calendarData
            }
        }, { merge: true });

        // Redirect user back to the application integrations panel
        // Ensure origin does not end with trailing slash if adding relative hash
        const cleanOrigin = origin.endsWith('/') ? origin.slice(0, -1) : origin;
        return res.redirect(`${cleanOrigin}/#integrationsView`);

    } catch (err) {
        console.error("OAuth Callback Handler Error:", err);
        return res.status(500).send("Internal Server Error during OAuth callback processing.");
    }
}
