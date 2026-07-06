import { getAdmin, isAuthorizedCron, getBadWordsList, findBadWord, disableAccount, REASON_LABELS } from './lib.js';

const INACTIVITY_DAYS = 150;
const RAPID_SIGNUP_WINDOW_MIN = 60;
const RAPID_SIGNUP_THRESHOLD = 3;
const FAILED_LOGIN_WINDOW_MIN = 15;
const FAILED_LOGIN_THRESHOLD = 5;

export default async function handler(req, res) {
    if (!isAuthorizedCron(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' });

    try {
        const { db } = getAdmin();
        const now = new Date();
        const results = { badBotName: 0, rapidSignup: 0, inactivity: 0, hackingSigns: 0, scanned: 0 };

        // ------------------------------------------------------------------
        // 1. Bad words in bot names
        // ------------------------------------------------------------------
        const badWords = await getBadWordsList();
        const botsSnap = await db.collection('user_bots').get();
        const ownerAlreadyFlagged = new Set();

        for (const botDoc of botsSnap.docs) {
            const bot = botDoc.data();
            if (bot.deletedAt || !bot.owner) continue;
            const hit = findBadWord(bot.name, badWords);
            if (hit) {
                const userRef = db.collection('users').doc(bot.owner);
                const userSnap = await userRef.get();
                const status = userSnap.exists ? userSnap.data().accountStatus : 'active';
                if (status === 'active' && !ownerAlreadyFlagged.has(bot.owner)) {
                    await disableAccount(db, bot.owner, 'bad_bot_name',
                        `${REASON_LABELS.bad_bot_name} (agent "${bot.name}")`);
                    ownerAlreadyFlagged.add(bot.owner);
                    results.badBotName++;
                }
            }
        }

        // ------------------------------------------------------------------
        // 2 & 3. Per-user checks: inactivity, rapid signup, hacking signs
        // ------------------------------------------------------------------
        const usersSnap = await db.collection('users').get();
        results.scanned = usersSnap.size;

        for (const userDoc of usersSnap.docs) {
            const email = userDoc.id;
            const user = userDoc.data();
            if (ownerAlreadyFlagged.has(email)) continue;
            if (user.accountStatus && user.accountStatus !== 'active') continue;

            // Inactivity
            const lastLogin = user.lastLoginAt ? new Date(user.lastLoginAt) : (user.signupAt ? new Date(user.signupAt) : null);
            if (lastLogin) {
                const daysSince = (now.getTime() - lastLogin.getTime()) / 86400000;
                if (daysSince >= INACTIVITY_DAYS) {
                    await disableAccount(db, email, 'inactivity', REASON_LABELS.inactivity);
                    results.inactivity++;
                    continue;
                }
            }

            // Rapid signup from same device/IP
            if (user.signupDeviceId || user.signupIp) {
                const windowStart = new Date(new Date(user.signupAt).getTime() - RAPID_SIGNUP_WINDOW_MIN * 60000);
                const windowEnd = new Date(new Date(user.signupAt).getTime() + RAPID_SIGNUP_WINDOW_MIN * 60000);
                let clusterQuery = user.signupDeviceId
                    ? db.collection('users').where('signupDeviceId', '==', user.signupDeviceId)
                    : db.collection('users').where('signupIp', '==', user.signupIp);
                const clusterSnap = await clusterQuery.get();
                const clusterInWindow = clusterSnap.docs.filter(d => {
                    const t = new Date(d.data().signupAt).getTime();
                    return t >= windowStart.getTime() && t <= windowEnd.getTime();
                });
                if (clusterInWindow.length >= RAPID_SIGNUP_THRESHOLD) {
                    await disableAccount(db, email, 'rapid_signup', REASON_LABELS.rapid_signup);
                    results.rapidSignup++;
                    continue;
                }
            }

            // Signs of hacking: brute-force style failed logins in a short window
            const recentWindow = new Date(now.getTime() - FAILED_LOGIN_WINDOW_MIN * 60000).toISOString();
            const failedSnap = await db.collection('users').doc(email)
                .collection('failedLogins').where('at', '>=', recentWindow).get();
            if (failedSnap.size >= FAILED_LOGIN_THRESHOLD) {
                await disableAccount(db, email, 'hacking_signs', REASON_LABELS.hacking_signs);
                results.hackingSigns++;
                continue;
            }
        }

        return res.status(200).json({ success: true, results });

    } catch (error) {
        console.error('Scan accounts error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
}
