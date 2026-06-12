// api/oauth/callback.js  (also used by api/oauth/google/callback.js — same file)
import { getAdminDb } from '../firebaseAdmin.js';

export default async function handler(req, res) {
    const { code, state, error } = req.query;

    if (error) return res.status(400).send(`OAuth Error: ${error}`);
    if (!code || !state) return res.status(400).send('Missing code or state.');

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
    const redirectUri  = process.env.GOOGLE_REDIRECT_URI || `https://${req.headers.host}/api/oauth/callback`;

    if (!clientId || !clientSecret) {
        return res.status(500).send('Server config error: missing Google credentials.');
    }

    try {
        // ── 1. Exchange auth code for tokens ──────────────────────────────────
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code, client_id: clientId, client_secret: clientSecret,
                redirect_uri: redirectUri, grant_type: 'authorization_code'
            })
        });
        const tokens = await tokenRes.json();

        if (tokens.error) {
            return res.status(400).send(`Token exchange failed: ${tokens.error_description || tokens.error}`);
        }

        // ── 2. Save to Firestore via Admin SDK (bypasses security rules) ──────
        const db = getAdminDb();
        const calendarData = {
            connected:    true,
            access_token: tokens.access_token,
            expiry_date:  tokens.expires_in
                ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
                : new Date(Date.now() + 3500 * 1000).toISOString()
        };
        if (tokens.refresh_token) calendarData.refresh_token = tokens.refresh_token;

        await db.collection('users').doc(email).set(
            { integrations: { google_calendar: calendarData } },
            { merge: true }
        );

        console.log('[OAuth] ✓ Google Calendar tokens saved for', email);

        // ── 3. Redirect back to app ───────────────────────────────────────────
        const cleanOrigin = origin.endsWith('/') ? origin.slice(0, -1) : origin;
        return res.redirect(`${cleanOrigin}/#integrationsView`);

    } catch (err) {
        console.error('[OAuth] Error:', err);
        const cleanOrigin = origin.endsWith('/') ? origin.slice(0, -1) : origin;
        return res.redirect(`${cleanOrigin}/#integrationsView?calendar_error=1`);
    }
}
