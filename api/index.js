const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());

async function extractUID(url) {
    let cleanUrl = url.trim();
    if (!cleanUrl.startsWith('http')) {
        cleanUrl = 'https://' + cleanUrl;
    }

    let match = cleanUrl.match(/[?&]id=(\d+)/);
    if (match && match[1]) {
        return { success: true, uid: match[1], method: 'direct_id' };
    }

    match = cleanUrl.match(/story_fbid=(\d+)/);
    if (match && match[1]) {
        const uidMatch = cleanUrl.match(/[?&]id=(\d+)/);
        if (uidMatch && uidMatch[1]) {
            return { success: true, uid: uidMatch[1], method: 'post_id' };
        }
    }

    let username = null;
    let userMatch = cleanUrl.match(/facebook\.com\/([^\/?&]+)/);
    if (userMatch && !userMatch[1].includes('profile.php') && !userMatch[1].includes('story.php')) {
        username = userMatch[1];
    }
    
    let mbasicMatch = cleanUrl.match(/mbasic\.facebook\.com\/([^\/?&]+)/);
    if (mbasicMatch) username = mbasicMatch[1];

    if (username) {
        try {
            const response = await axios.get(`https://mbasic.facebook.com/${username}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                maxRedirects: 5,
                timeout: 10000
            });
            
            const finalUrl = response.request.res.responseUrl;
            let idMatch = finalUrl.match(/[?&]id=(\d+)/);
            if (idMatch) return { success: true, uid: idMatch[1], method: 'username_mbasic' };
            
            const html = response.data;
            let uidMatch = html.match(/\"userID\":\"(\d+)\"/);
            if (uidMatch) return { success: true, uid: uidMatch[1], method: 'username_mbasic' };
            
            uidMatch = html.match(/\"profile_id\":\"(\d+)\"/);
            if (uidMatch) return { success: true, uid: uidMatch[1], method: 'username_mbasic' };
        } catch (err) {
            console.error('Lỗi mbasic:', err.message);
        }
    }

    try {
        const graphUrl = `https://graph.facebook.com/v18.0/?id=${encodeURIComponent(cleanUrl)}`;
        const response = await axios.get(graphUrl, { timeout: 8000 });
        if (response.data && response.data.id) {
            return { success: true, uid: response.data.id, method: 'graph_api' };
        }
    } catch (err) {}

    try {
        const response = await axios.get(cleanUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 10000
        });
        
        const $ = cheerio.load(response.data);
        const html = response.data;
        
        const patterns = [
          /\"userID\":\"(\d+)\"/,
          /\"profile_id\":\"(\d+)\"/,
          /\"id\":\"(\d+)\",\"name\":/,
          /profile\.php\?id=(\d+)/,
          /pages\/\?id=(\d+)/
        ];
        
        for (const pattern of patterns) {
            const found = html.match(pattern);
            if (found && found[1] && found[1].length >= 10) {
                return { success: true, uid: found[1], method: 'html_parse' };
            }
        }
        
        const metaOg = $('meta[property="al:android:url"]').attr('content');
        if (metaOg && metaOg.includes('id=')) {
            const extractedId = metaOg.match(/id=(\d+)/);
            if (extractedId) return { success: true, uid: extractedId[1], method: 'html_parse' };
        }
    } catch (err) {
        console.error('Lỗi parse HTML:', err.message);
    }

    return { success: false, error: 'Không thể tìm thấy UID' };
}

app.post('/api/get-uid', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ success: false, error: 'Vui lòng nhập link Facebook' });
    }
    try {
        const result = await extractUID(url);
        if (result.success) {
            res.json({ success: true, uid: result.uid, method: result.method, url: url });
        } else {
            res.status(404).json({ success: false, error: result.error || 'Không tìm thấy UID' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: 'Lỗi máy chủ' });
    }
});

app.post('/api/batch-get-uid', async (req, res) => {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ success: false, error: 'Vui lòng cung cấp mảng các URL' });
    }
    if (urls.length > 20) {
        return res.status(400).json({ success: false, error: 'Tối đa 20 URL mỗi lần' });
    }
    const results = [];
    for (const url of urls) {
        const result = await extractUID(url);
        results.push({ url, ...result });
    }
    res.json({ success: true, total: urls.length, results });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

module.exports = app;
