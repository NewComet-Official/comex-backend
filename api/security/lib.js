import { initializeApp, getApps, getApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

// ============================================================================
// FIREBASE ADMIN INIT (server-side, full read/write + ability to delete
// Auth users — the client SDK used elsewhere in this project cannot do that)
// ============================================================================
// Requires an env var FIREBASE_SERVICE_ACCOUNT containing the full JSON of a
// Firebase service account key (Project Settings -> Service Accounts ->
// Generate New Private Key), stored as a single-line JSON string.
export function getAdmin() {
    if (!getApps().length) {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (!raw) {
            throw new Error('Missing FIREBASE_SERVICE_ACCOUNT environment variable.');
        }
        const serviceAccount = JSON.parse(raw);
        initializeApp({ credential: cert(serviceAccount) });
    } else {
        getApp();
    }
    return { db: getFirestore(), auth: getAuth() };
}

// Simple shared secret so random visitors can't trigger scans/purges.
// Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` on cron
// invocations when a CRON_SECRET env var is set — see Vercel's cron docs.
export function isAuthorizedCron(req) {
    const secret = process.env.CRON_SECRET;
    if (!secret) return true; // no secret configured yet — allow (dev mode)
    const header = req.headers['authorization'] || '';
    return header === `Bearer ${secret}`;
}

// ============================================================================
// BAD WORD LIST (fetched from the public LDNOOBW V2 list, cached in memory)
// ============================================================================
let badWordsCache = null;
let badWordsCachedAt = 0;
const BADWORDS_TTL_MS = 6 * 60 * 60 * 1000; // refresh every 6 hours

export async function getBadWordsList() {
    const now = Date.now();
    if (badWordsCache && (now - badWordsCachedAt) < BADWORDS_TTL_MS) {
        return badWordsCache;
    }
    try {
        const res = await fetch('https://raw.githubusercontent.com/LDNOOBWV2/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words_V2/main/data/en.txt');
        const text = await res.text();
        badWordsCache = text.split('\n').map(w => w.trim().toLowerCase()).filter(Boolean);
        badWordsCachedAt = now;
    } catch (err) {
        console.error('Failed to fetch bad words list:', err);
        if (!badWordsCache) badWordsCache = []; // fail open rather than crash
    }
    return badWordsCache;
}

// Word-boundary aware check so e.g. "class" doesn't match "ass".
export function findBadWord(name, wordList) {
    if (!name) return null;
    const normalized = name.toLowerCase();
    const tokens = normalized.split(/[^a-z0-9]+/i).filter(Boolean);
    for (const word of wordList) {
        if (!word) continue;
        if (tokens.includes(word)) return word;
        // also catch bad words embedded with no separators (e.g. "sh1tbot")
        if (word.length > 3 && normalized.includes(word)) return word;
    }
    return null;
}

// ============================================================================
// GEO-IP LOOKUP (free, no API key required)
// ============================================================================
export function getClientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return fwd.split(',')[0].trim();
    return req.socket?.remoteAddress || '0.0.0.0';
}

export async function getGeoFromIp(ip) {
    if (!ip || ip === '0.0.0.0' || ip.startsWith('127.') || ip.startsWith('::1')) {
        return { ip, lat: null, lon: null, country: 'Unknown', city: 'Unknown' };
    }
    try {
        const res = await fetch(`https://ipapi.co/${ip}/json/`);
        const data = await res.json();
        if (data.error) throw new Error(data.reason || 'geo lookup failed');
        return {
            ip,
            lat: data.latitude ?? null,
            lon: data.longitude ?? null,
            country: data.country_name || 'Unknown',
            city: data.city || 'Unknown'
        };
    } catch (err) {
        return { ip, lat: null, lon: null, country: 'Unknown', city: 'Unknown' };
    }
}

// Haversine distance in kilometers
export function distanceKm(lat1, lon1, lat2, lon2) {
    if ([lat1, lon1, lat2, lon2].some(v => v === null || v === undefined)) return 0;
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============================================================================
// DISABLE / helper writers
// ============================================================================
export async function disableAccount(db, email, reasonCode, reasonText) {
    await db.collection('users').doc(email).set({
        accountStatus: 'disabled',
        disabledAt: new Date().toISOString(),
        disabledReasonCode: reasonCode,
        disabledReason: reasonText,
        reviewStatus: null,
        reviewText: null,
        reviewRequestedAt: null,
        reviewRevealAt: null,
        reviewDecision: null,
        permanentDeleteAt: null
    }, { merge: true });
}

export const REASON_LABELS = {
    bad_bot_name: 'One of your AI agents was named using prohibited language.',
    rapid_signup: 'Multiple accounts were created rapidly from the same device.',
    inactivity: 'This account has been inactive for an extended period (150+ days).',
    geo_anomaly: 'We detected a login from an unusual, distant location shortly after your last login.',
    hacking_signs: 'We detected suspicious activity consistent with unauthorized access attempts.'
};
