const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Cấu hình token
const HACKLIKE17_TOKEN = process.env.HACKLIKE17_TOKEN || '';

// --- CÁC HÀM XỬ LÝ TIKTOK ---
async function resolveTikTokShortLink(shortUrl) {
    try {
        const response = await axios.get(shortUrl, {
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 400,
            timeout: 10000
        });
        if (response.status === 301 || response.status === 302) {
            return response.headers.location;
        }
        return shortUrl;
    } catch (error) {
        if (error.response && (error.response.status === 301 || error.response.status === 302)) {
            return error.response.headers.location;
        }
        console.error('Lỗi resolve TikTok short link:', error.message);
        return null;
    }
}

async function getTikTokVideoInfo(tiktokUrl) {
    try {
        const fullUrl = await resolveTikTokShortLink(tiktokUrl);
        if (!fullUrl) return { success: false, error: 'Không thể phân giải link TikTok' };
        console.log(`Đã phân giải: ${tiktokUrl} -> ${fullUrl}`);
        
        const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(fullUrl)}`;
        const response = await axios.get(oembedUrl, { timeout: 10000 });
        
        if (response.data) {
            let videoId = null;
            const idMatch = fullUrl.match(/\/video\/(\d+)/);
            if (idMatch) videoId = idMatch[1];
            
            return {
                success: true,
                method: 'oembed_api',
                title: response.data.title,
                author_name: response.data.author_name,
                author_url: response.data.author_url,
                video_id: videoId,
                embed_html: response.data.html,
                thumbnail_url: response.data.thumbnail_url,
                original_url: fullUrl
            };
        }
        return { success: false, error: 'Không thể lấy thông tin video từ oEmbed' };
    } catch (error) {
        console.error('Lỗi lấy thông tin TikTok video:', error.message);
        return { success: false, error: error.message };
    }
}
// --- KẾT THÚC PHẦN TIKTOK ---

// --- CÁC HÀM XỬ LÝ FACEBOOK (TỪ BÀI TRƯỚC) ---
async function getUIDFromUsernameViaHacklike(username) {
    if (!HACKLIKE17_TOKEN) return { success: false, error: 'Chưa cấu hình token Hacklike17' };
    try {
        const response = await axios.post('https://hacklike17.com/api/fb_info/uid',
            new URLSearchParams({ token: HACKLIKE17_TOKEN, username: username }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
        );
        if (response.data && response.data.uid) return { success: true, uid: response.data.uid, method: 'hacklike17_api' };
        else return { success: false, error: response.data?.error || 'Không tìm thấy UID' };
    } catch (err) {
        console.error('Lỗi gọi Hacklike17 UID:', err.message);
        return { success: false, error: err.message };
    }
}

async function getUIDFromPostViaHacklike(postUrl) {
    if (!HACKLIKE17_TOKEN) return { success: false, error: 'Chưa cấu hình token Hacklike17' };
    try {
        const response = await axios.post('https://hacklike17.com/api/fb_info/post',
            new URLSearchParams({ token: HACKLIKE17_TOKEN, url: postUrl }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
        );
        if (response.data && (response.data.id || response.data.owner_id || response.data.uid)) {
            const uid = response.data.id || response.data.owner_id || response.data.uid;
            return { success: true, uid: uid, method: 'hacklike17_post_api' };
        } else return { success: false, error: response.data?.error || 'Không lấy được UID bài viết' };
    } catch (err) {
        console.error('Lỗi gọi Hacklike17 Post:', err.message);
        return { success: false, error: err.message };
    }
}

async function getUIDFromUsername(username) {
    const hacklikeResult = await getUIDFromUsernameViaHacklike(username);
    if (hacklikeResult.success) return hacklikeResult;
    return { success: false, error: hacklikeResult.error };
}

async function getUIDFromPost(postUrl) {
    const hacklikeResult = await getUIDFromPostViaHacklike(postUrl);
    if (hacklikeResult.success) return hacklikeResult;
    return { success: false, error: hacklikeResult.error };
}
// --- KẾT THÚC PHẦN FACEBOOK ---

// --- CÁC API CHO FRONTEND GỌI ---
app.post('/api/get-uid', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'Vui lòng nhập link Facebook' });
    if (url.includes('/posts/') || url.includes('story_fbid=')) {
        const result = await getUIDFromPost(url);
        if (result.success) return res.json(result);
        else return res.status(404).json(result);
    }
    let username = url;
    const match = url.match(/facebook\.com\/([^\/?&]+)/);
    if (match && match[1]) username = match[1];
    const result = await getUIDFromUsername(username);
    if (result.success) return res.json(result);
    else return res.status(404).json(result);
});

app.post('/api/get-uid-from-username', async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ success: false, error: 'Vui lòng nhập username' });
    const result = await getUIDFromUsername(username);
    if (result.success) res.json(result);
    else res.status(404).json(result);
});

app.post('/api/get-uid-from-post', async (req, res) => {
    const { postUrl } = req.body;
    if (!postUrl) return res.status(400).json({ success: false, error: 'Vui lòng nhập link bài viết' });
    const result = await getUIDFromPost(postUrl);
    if (result.success) res.json(result);
    else res.status(404).json(result);
});

app.post('/api/batch-get-uid', async (req, res) => {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls)) return res.status(400).json({ success: false, error: 'Cần mảng URLs' });
    const results = [];
    for (const url of urls.slice(0, 20)) {
        if (url.includes('/posts/') || url.includes('story_fbid=')) {
            const result = await getUIDFromPost(url);
            results.push({ url, ...result });
        } else {
            let username = url;
            const match = url.match(/facebook\.com\/([^\/?&]+)/);
            if (match) username = match[1];
            const result = await getUIDFromUsername(username);
            results.push({ url, ...result });
        }
    }
    res.json({ success: true, results });
});

// --- API TIKTOK MỚI ---
app.post('/api/tiktok/info', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'Vui lòng nhập link TikTok' });
    const result = await getTikTokVideoInfo(url);
    if (result.success) res.json(result);
    else res.status(404).json(result);
});

app.post('/api/tiktok/resolve-short-link', async (req, res) => {
    const { shortUrl } = req.body;
    if (!shortUrl) return res.status(400).json({ success: false, error: 'Vui lòng nhập link TikTok rút gọn' });
    const fullUrl = await resolveTikTokShortLink(shortUrl);
    if (fullUrl) res.json({ success: true, original_url: shortUrl, full_url: fullUrl });
    else res.status(404).json({ success: false, error: 'Không thể phân giải link' });
});

app.get('/api/health', (req, res) => res.json({ 
    status: 'OK', 
    hasToken: !!HACKLIKE17_TOKEN,
    tiktok: 'available'
}));

module.exports = app;
