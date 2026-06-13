// api/oauth/google/callback.js
import { getAdminDb } from '../../firebaseAdmin.js';

export default async function handler(req, res) {
    const { code, state, error } = req.query;

    if (error) return res.status(400).send(`OAuth Error: ${error}`);
    if (!code || !state) return res.status(400).send('Missing code or state parameters.');

    let email = '', origin = '';
    try {
        const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
        email  = decoded.email;
        origin = decoded.origin;
    } catch {
        email  = state;
        origin = `https://${req.headers.host}`;
    }

    const clientId     = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri  = process.env.GOOGLE_REDIRECT_URI ||
                         `https://${req.headers.host}/api/oauth/google/callback`;

    if (!clientId || !clientSecret) {
        return res.status(500).send('Server config error: missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET.');
    }

    try {
        // Exchange auth code for access + refresh tokens
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id:     clientId,
                client_secret: clientSecret,
                redirect_uri:  redirectUri,
                grant_type:    'authorization_code'
            })
        });
        const tokens = await tokenRes.json();

        if (tokens.error) {
            return res.status(400).send(`Token exchange failed: ${tokens.error_description || tokens.error}`);
        }

        // Build calendar data object
        const calendarData = {
            connected:    true,
            access_token: tokens.access_token,
            expiry_date:  tokens.expires_in
                ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
                : new Date(Date.now() + 3500 * 1000).toISOString()
        };
        if (tokens.refresh_token) {
            calendarData.refresh_token = tokens.refresh_token;
        }

        // Save to Firestore via Admin SDK (bypasses security rules)
        const db = getAdminDb();
        await db.collection('users').doc(email).set(
            { integrations: { google_calendar: calendarData } },
            { merge: true }
        );

        console.log('[OAuth/Google] ✓ Tokens saved for:', email);

        // Redirect back to the integrations panel
        const cleanOrigin = origin.endsWith('/') ? origin.slice(0, -1) : origin;
        return res.redirect(`${cleanOrigin}/#integrationsView`);

    } catch (err) {
        console.error('[OAuth/Google] Error:', err);
        return res.status(500).send(`Internal server error: ${err.message}`);
    }
}
