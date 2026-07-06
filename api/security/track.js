import { getAdmin, getClientIp, getGeoFromIp, distanceKm } from './lib.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

    try {
        const { email, type, deviceId } = req.body; // type: 'signup' | 'login_success' | 'login_failed'
        if (!email || !type) {
            return res.status(400).json({ success: false, message: 'Missing email or type.' });
        }

        const { db } = getAdmin();
        const ip = getClientIp(req);
        const userAgent = req.headers['user-agent'] || 'unknown';
        const userRef = db.collection('users').doc(email);
        const now = new Date();

        if (type === 'signup') {
            const geo = await getGeoFromIp(ip);
            await userRef.set({
                accountStatus: 'active',
                signupAt: now.toISOString(),
                signupIp: ip,
                signupDeviceId: deviceId || null,
                signupGeo: geo,
                lastLoginAt: now.toISOString()
            }, { merge: true });
            return res.status(200).json({ success: true, accountStatus: 'active' });
        }

        if (type === 'login_failed') {
            await userRef.collection('failedLogins').add({ ip, userAgent, at: now.toISOString() });
            return res.status(200).json({ success: true });
        }

        if (type === 'login_success') {
            const snap = await userRef.get();
            const data = snap.exists ? snap.data() : {};

            // Look up geo + compare to the most recent prior login for anomaly detection
            const geo = await getGeoFromIp(ip);
            const priorLoginsSnap = await userRef.collection('loginHistory')
                .orderBy('at', 'desc').limit(1).get();

            let geoAnomaly = false;
            if (!priorLoginsSnap.empty) {
                const prior = priorLoginsSnap.docs[0].data();
                const hoursSince = (now.getTime() - new Date(prior.at).getTime()) / 3600000;
                const km = distanceKm(prior.lat, prior.lon, geo.lat, geo.lon);
                // "impossible travel": too far, too fast (rough commercial-airline heuristic)
                if (hoursSince > 0 && hoursSince < 3 && km > 800) {
                    geoAnomaly = true;
                }
            }

            await userRef.collection('loginHistory').add({
                ip, userAgent, at: now.toISOString(),
                lat: geo.lat, lon: geo.lon, country: geo.country, city: geo.city
            });
            await userRef.set({ lastLoginAt: now.toISOString() }, { merge: true });

            // If a review decision was made and its 48h reveal window has now
            // passed, finalize it: reinstate the account, or leave it disabled
            // (it will be deleted by the purge cron once permanentDeleteAt hits).
            if (data.reviewStatus === 'decided' && data.reviewRevealAt && now >= new Date(data.reviewRevealAt)) {
                if (data.reviewDecision === 'enabled') {
                    await userRef.set({
                        accountStatus: 'active',
                        reviewStatus: 'revealed_enabled',
                        disabledReasonCode: null,
                        disabledReason: null
                    }, { merge: true });
                    data.accountStatus = 'active';
                    data.reviewStatus = 'revealed_enabled';
                } else {
                    await userRef.set({ reviewStatus: 'revealed_disabled' }, { merge: true });
                    data.reviewStatus = 'revealed_disabled';
                }
            }

            if (geoAnomaly && data.accountStatus === 'active') {
                await userRef.set({
                    accountStatus: 'disabled',
                    disabledAt: now.toISOString(),
                    disabledReasonCode: 'geo_anomaly',
                    disabledReason: 'We detected a login from an unusual, distant location shortly after your last login.'
                }, { merge: true });
                data.accountStatus = 'disabled';
                data.disabledReason = 'We detected a login from an unusual, distant location shortly after your last login.';
            }

            return res.status(200).json({
                success: true,
                accountStatus: data.accountStatus || 'active',
                disabledReason: data.disabledReason || null,
                reviewStatus: data.reviewStatus || null,
                reviewRevealAt: data.reviewRevealAt || null,
                reviewDecision: data.reviewDecision || null,
                permanentDeleteAt: data.permanentDeleteAt || null
            });
        }

        return res.status(400).json({ success: false, message: 'Unknown type.' });

    } catch (error) {
        console.error('Track endpoint error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
}
