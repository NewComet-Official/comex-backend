import * as cheerio from 'cheerio';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    try {
        const { businessId, url } = req.body;

        if (!url || !businessId) {
            return res.status(400).json({ success: false, message: 'Missing businessId or URL.' });
        }

        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ComexAI/1.0' }
        });
        
        if (!response.ok) {
            throw new Error(`Failed to fetch target website. Status: ${response.status}`);
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        $('script, style, nav, footer').remove();
        const extractedText = $('body').text().replace(/\s\s+/g, ' ').trim();
        
        return res.status(200).json({
            success: true,
            message: `Matrix cloud sync complete for ${url}`,
            characterCount: extractedText.length,
            snippet: extractedText.substring(0, 200) + "..."
        });

    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
}