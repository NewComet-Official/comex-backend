// api/firebaseAdmin.js
// ─────────────────────────────────────────────────────────────────────────────
// Singleton Firebase Admin SDK initializer.
// ALL backend API files import getAdminDb() from here.
// Admin SDK bypasses Firestore security rules entirely — correct for servers.
//
// Required Vercel env var:
//   FIREBASE_SERVICE_ACCOUNT_JSON  →  base64-encoded service account JSON
//   (see README section below for how to create it)
// ─────────────────────────────────────────────────────────────────────────────

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
                'Missing env var: FIREBASE_SERVICE_ACCOUNT_JSON. ' +
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

/*
 HOW TO CREATE FIREBASE_SERVICE_ACCOUNT_JSON
 ─────────────────────────────────────────────
 1. Firebase Console → Project Settings (gear icon) → Service Accounts tab
 2. Click "Generate new private key" → Confirm → a JSON file downloads
 3. In your terminal run:
      base64 -i path/to/serviceAccount.json | tr -d '\n'
    (On Windows PowerShell:)
      [Convert]::ToBase64String([IO.File]::ReadAllBytes("path\to\serviceAccount.json"))
 4. Copy the output string
 5. Vercel Dashboard → your project → Settings → Environment Variables
    Name:  FIREBASE_SERVICE_ACCOUNT_JSON
    Value: <paste the base64 string>
    Environments: Production + Preview + Development
 6. Redeploy
*/
