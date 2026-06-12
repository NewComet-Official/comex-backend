// api/scrape.js
import * as cheerio from 'cheerio';
import { getAdminDb } from './firebaseAdmin.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')   return res.status(405).json({ success: false, message: 'Method Not Allowed' });

    const { businessId, url } = req.body;
    if (!url || !businessId) return res.status(400).json({ success: false, message: 'Missing businessId or url.' });

    try {
        const pageRes = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 ComexAI/1.0' }
        });
        if (!pageRes.ok) throw new Error(`Failed to fetch ${url} — status ${pageRes.status}`);

        const $ = cheerio.load(await pageRes.text());
        $('script, style, nav, footer, iframe').remove();
        const text = $('body').text().replace(/\s\s+/g, ' ').trim();

        if (!text || text.length < 10) throw new Error('Extracted text too short or empty.');

        const db = getAdminDb();
        await db.collection('user_bots').doc(businessId).set(
            { context: text },
            { merge: true }
        );

        return res.json({ success: true, message: `Scraped and saved ${text.length} chars.`, snippet: text.substring(0,200) });
    } catch (err) {
        console.error('[Scrape] Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
}
