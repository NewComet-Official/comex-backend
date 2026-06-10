export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { email } = req.query;
    if (!email) {
        return res.status(400).json({ success: false, error: "Missing email parameter." });
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
        return res.status(500).json({ 
            success: false, 
            error: "Server configuration missing GOOGLE_CLIENT_ID environment variable." 
        });
    }

    const origin = req.query.origin || req.headers.referer || `https://${req.headers.host}`;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || `https://${req.headers.host}/api/oauth/callback`;

    // Request access to calendar and calendar events
    const scopes = [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/calendar.events'
    ].join(' ');

    // Base64 encode JSON state containing email and origin to return to after auth callback
    const state = Buffer.from(JSON.stringify({ email, origin })).toString('base64');

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.append('client_id', clientId);
    authUrl.searchParams.append('redirect_uri', redirectUri);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('scope', scopes);
    authUrl.searchParams.append('access_type', 'offline');
    authUrl.searchParams.append('prompt', 'consent'); // Force consent to guarantee we get a refresh_token
    authUrl.searchParams.append('state', state);      // Pass encoded state

    // Redirect user to Google OAuth screen
    return res.redirect(authUrl.toString());
}
