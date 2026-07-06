import { getAdmin, isAuthorizedCron } from './lib.js';

export default async function handler(req, res) {
    if (!isAuthorizedCron(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' });

    try {
        const { db, auth } = getAdmin();
        const now = new Date().toISOString();

        const dueSnap = await db.collection('users')
            .where('reviewDecision', '==', 'permanently_disabled')
            .where('permanentDeleteAt', '<=', now)
            .get();

        let deleted = 0;
        for (const userDoc of dueSnap.docs) {
            const email = userDoc.id;
            try {
                // Delete the Firebase Auth account, if it exists
                try {
                    const authUser = await auth.getUserByEmail(email);
                    await auth.deleteUser(authUser.uid);
                } catch (e) {
                    // Auth user may already be gone / not found — fine, continue cleanup
                }

                // Delete owned bots + their subcollections (appointments, chats)
                const botsSnap = await db.collection('user_bots').where('owner', '==', email).get();
                for (const botDoc of botsSnap.docs) {
                    await deleteCollection(db, botDoc.ref.collection('appointments'));
                    await deleteCollection(db, botDoc.ref.collection('chats'));
                    await botDoc.ref.delete();
                }

                // Delete login history / failed login subcollections, then the user doc
                await deleteCollection(db, userDoc.ref.collection('loginHistory'));
                await deleteCollection(db, userDoc.ref.collection('failedLogins'));
                await userDoc.ref.delete();

                deleted++;
            } catch (err) {
                console.error(`Failed to purge ${email}:`, err);
            }
        }

        return res.status(200).json({ success: true, deleted });

    } catch (error) {
        console.error('Purge accounts error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
}

async function deleteCollection(db, collectionRef) {
    const snap = await collectionRef.get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    if (!snap.empty) await batch.commit();
}
