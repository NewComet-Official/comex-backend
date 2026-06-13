// api/firebaseAdmin.js
// Singleton Firebase Admin SDK — imported by every API route.
// Requires env var: FIREBASE_SERVICE_ACCOUNT_JSON (base64-encoded service account JSON)

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let _db = null;

export function getAdminDb() {
    if (_db) return _db;

    const admin = require('firebase-admin');

    if (!admin.apps.length) {
        const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
        if (!b64) {
            throw new Error(
                'Missing FIREBASE_SERVICE_ACCOUNT_JSON env var. ' +
                'Go to Firebase Console → Project Settings → Service Accounts → Generate new private key, ' +
                'then base64-encode the JSON and add it to Vercel environment variables.'
            );
        }
        const serviceAccount = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }

    _db = admin.firestore();
    return _db;
}
