// api/oauth/google.js
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { email, origin: reqOrigin } = req.query;
    if (!email) {
        return res.status(400).json({ success: false, error: 'Missing email parameter.' });
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
        return res.status(500).json({
            success: false,
            error: 'Server missing GOOGLE_CLIENT_ID environment variable.'
        });
    }

    const origin      = reqOrigin || req.headers.referer || `https://${req.headers.host}`;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI ||
                        `https://${req.headers.host}/api/oauth/google/callback`;

    const scopes = [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/calendar.events'
    ].join(' ');

    const state = Buffer.from(JSON.stringify({ email, origin })).toString('base64');

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.append('client_id',     clientId);
    authUrl.searchParams.append('redirect_uri',  redirectUri);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('scope',         scopes);
    authUrl.searchParams.append('access_type',   'offline');
    authUrl.searchParams.append('prompt',        'consent');
    authUrl.searchParams.append('state',         state);

    return res.redirect(authUrl.toString());
}
