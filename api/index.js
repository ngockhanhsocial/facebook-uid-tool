const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());

// Cấu hình token Facebook (nếu có) - bạn có thể để trống nếu không dùng
const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN || '';

// ================== CÁC HÀM TRÍCH XUẤT UID ==================

// Hàm trích xuất username từ link
function extractUsername(url) {
    const patterns = [
        /facebook\.com\/(?!profile\.php)(?!photo\.php)(?!watch)(?!posts\/)(?!story\.php)([^\/?&]+)/,
        /mbasic\.facebook\.com\/([^\/?&]+)/,
        /m\.facebook\.com\/([^\/?&]+)/
    ];
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1] && !match[1].includes('.') && !match[1].includes('?')) {
            return match[1];
        }
    }
    return null;
}

// Lấy UID từ username (profile, page)
async function getUIDFromUsername(username, useToken = true) {
    // Phương thức 1: Dùng token Graph API (mạnh nhất, lấy được cả riêng tư nếu token có quyền)
    if (useToken && FB_ACCESS_TOKEN) {
        try {
            const graphUrl = `https://graph.facebook.com/v18.0/${username}?access_token=${FB_ACCESS_TOKEN}&fields=id`;
            const response = await axios.get(graphUrl, { timeout: 8000 });
            if (response.data && response.data.id) {
                return { success: true, uid: response.data.id, method: 'graph_api_token' };
            }
        } catch (err) {}
    }

    // Phương thức 2: Dùng JSON API nội bộ (không cần token, chỉ hoạt động với profile công khai)
    try {
        const jsonUrl = `https://www.facebook.com/${username}?__a=1&__d=1`;
        const response = await axios.get(jsonUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 10000
        });
        const data = response.data;
        const jsonStr = JSON.stringify(data);
        const idMatch = jsonStr.match(/"userID":"(\d+)"/) || jsonStr.match(/"profile_id":"(\d+)"/);
        if (idMatch) return { success: true, uid: idMatch[1], method: 'json_api' };
    } catch (err) {}

    // Phương thức 3: Mbasic redirect
    try {
        const mbasicUrl = `https://mbasic.facebook.com/${username}`;
        const response = await axios.get(mbasicUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            maxRedirects: 5,
            timeout: 10000
        });
        const finalUrl = response.request.res.responseUrl;
        let idMatch = finalUrl.match(/[?&]id=(\d+)/);
        if (idMatch) return { success: true, uid: idMatch[1], method: 'mbasic_redirect' };
        const html = response.data;
        const uidMatch = html.match(/\"userID\":\"(\d+)\"/) || html.match(/\"profile_id\":\"(\d+)\"/);
        if (uidMatch) return { success: true, uid: uidMatch[1], method: 'mbasic_parse' };
    } catch (err) {}

    return { success: false, error: 'Không tìm thấy UID. Có thể profile ở chế độ riêng tư và bạn chưa cấu hình token.' };
}

// Lấy UID từ link bài viết (post)
async function getUIDFromPost(postUrl) {
    // Chuẩn hóa link post
    let cleanUrl = postUrl.trim();
    if (!cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl;

    // Trường hợp link có sẵn ?id= (thường là của page)
    let match = cleanUrl.match(/[?&]id=(\d+)/);
    if (match) return { success: true, uid: match[1], method: 'direct_id' };

    // Thử lấy từ JSON API của post
    try {
        // Thay đổi thành dạng ?__a=1
        const jsonUrl = cleanUrl.includes('?') ? cleanUrl + '&__a=1' : cleanUrl + '?__a=1';
        const response = await axios.get(jsonUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000
        });
        const data = response.data;
        const jsonStr = JSON.stringify(data);
        // Tìm ID của người đăng
        const uidMatch = jsonStr.match(/\"owner\":\{\"id\":\"(\d+)\"/) ||
                         jsonStr.match(/\"userID\":\"(\d+)\"/) ||
                         jsonStr.match(/\"profile_id\":\"(\d+)\"/);
        if (uidMatch) return { success: true, uid: uidMatch[1], method: 'post_json' };
    } catch (err) {}

    // Phương pháp dùng Graph API (nếu có token)
    if (FB_ACCESS_TOKEN) {
        try {
            // Lấy post ID từ URL
            let postId = null;
            const postMatch = cleanUrl.match(/\/posts\/(\d+)/) || cleanUrl.match(/story_fbid=(\d+)/);
            if (postMatch) postId = postMatch[1];
            if (postId) {
                const graphUrl = `https://graph.facebook.com/v18.0/${postId}?access_token=${FB_ACCESS_TOKEN}&fields=from`;
                const response = await axios.get(graphUrl, { timeout: 8000 });
                if (response.data && response.data.from && response.data.from.id) {
                    return { success: true, uid: response.data.from.id, method: 'graph_api_post' };
                }
            }
        } catch (err) {}
    }

    // Fallback: parse HTML bài viết (thường lấy được ID của người đăng)
    try {
        const response = await axios.get(cleanUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const html = response.data;
        const patterns = [
            /\"owner\":\{\"id\":\"(\d+)\"/,
            /\"profile_id\":\"(\d+)\"/,
            /\"userID\":\"(\d+)\"/
        ];
        for (const pattern of patterns) {
            const found = html.match(pattern);
            if (found) return { success: true, uid: found[1], method: 'post_html' };
        }
    } catch (err) {}

    return { success: false, error: 'Không thể lấy UID từ bài viết này. Có thể bài viết ở chế độ riêng tư.' };
}

// Hàm tổng hợp tự động nhận dạng
async function extractUID(url) {
    // Kiểm tra nếu là link post
    if (url.includes('/posts/') || url.includes('story_fbid=') || url.includes('/photo/')) {
        return await getUIDFromPost(url);
    }
    // Nếu có username
    const username = extractUsername(url);
    if (username) {
        return await getUIDFromUsername(username, true);
    }
    // Nếu có sẵn id
    const match = url.match(/[?&]id=(\d+)/);
    if (match) return { success: true, uid: match[1], method: 'direct_id' };
    return { success: false, error: 'Không nhận dạng được loại link' };
}

// ================== API ENDPOINTS ==================

// API lấy UID từ username (riêng biệt)
app.post('/api/get-uid-from-username', async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ success: false, error: 'Vui lòng nhập username' });
    try {
        const result = await getUIDFromUsername(username, true);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API lấy UID từ link post
app.post('/api/get-uid-from-post', async (req, res) => {
    const { postUrl } = req.body;
    if (!postUrl) return res.status(400).json({ success: false, error: 'Vui lòng nhập link bài viết' });
    try {
        const result = await getUIDFromPost(postUrl);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API tổng hợp (tự động nhận dạng)
app.post('/api/get-uid', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'Vui lòng nhập link Facebook' });
    try {
        const result = await extractUID(url);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API batch (giữ nguyên)
app.post('/api/batch-get-uid', async (req, res) => {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls)) return res.status(400).json({ success: false, error: 'Cần mảng URLs' });
    const results = [];
    for (const url of urls.slice(0, 20)) {
        const result = await extractUID(url);
        results.push({ url, ...result });
    }
    res.json({ success: true, results });
});

app.get('/api/health', (req, res) => res.json({ status: 'OK' }));

module.exports = app;
