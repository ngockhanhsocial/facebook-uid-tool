const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());

// Hàm lấy UID mạnh mẽ với nhiều phương thức
async function extractUID(url) {
    let cleanUrl = url.trim();
    if (!cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl;

    // 1. Lấy trực tiếp từ ?id=
    let match = cleanUrl.match(/[?&]id=(\d+)/);
    if (match && match[1]) return { success: true, uid: match[1], method: 'direct_id' };

    // 2. Thử với API JSON nội bộ (cách mới, rất hiệu quả)
    try {
        // Lấy username từ link
        let username = extractUsername(cleanUrl);
        if (username) {
            // Gọi API json của Facebook (không cần token)
            const jsonUrl = `https://www.facebook.com/${username}?__a=1&__d=1`;
            const response = await axios.get(jsonUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json'
                },
                timeout: 10000
            });
            // Phân tích dữ liệu JSON
            const data = response.data;
            if (data && data.payload && data.payload.actions) {
                // Tìm ID trong các action
                const jsonStr = JSON.stringify(data);
                const idMatch = jsonStr.match(/"userID":"(\d+)"/);
                if (idMatch) return { success: true, uid: idMatch[1], method: 'json_api' };
            }
        }
    } catch (err) {
        // Bỏ qua lỗi, thử phương thức khác
    }

    // 3. Phương thức mbasic cải tiến
    try {
        let username = extractUsername(cleanUrl);
        if (username) {
            const mbasicUrl = `https://mbasic.facebook.com/${username}`;
            const response = await axios.get(mbasicUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                maxRedirects: 5,
                timeout: 10000
            });
            const finalUrl = response.request.res.responseUrl;
            let idMatch = finalUrl.match(/[?&]id=(\d+)/);
            if (idMatch) return { success: true, uid: idMatch[1], method: 'mbasic_redirect' };
            
            // Tìm trong HTML
            const html = response.data;
            const uidMatch = html.match(/\"userID\":\"(\d+)\"/) || html.match(/\"profile_id\":\"(\d+)\"/);
            if (uidMatch) return { success: true, uid: uidMatch[1], method: 'mbasic_parse' };
        }
    } catch (err) {
        // Bỏ qua
    }

    // 4. Thử dùng Graph API công khai (không token)
    try {
        const graphUrl = `https://graph.facebook.com/v18.0/?id=${encodeURIComponent(cleanUrl)}`;
        const response = await axios.get(graphUrl, { timeout: 8000 });
        if (response.data && response.data.id) {
            return { success: true, uid: response.data.id, method: 'graph_api' };
        }
    } catch (err) {}

    // 5. Parse từ HTML của trang chính
    try {
        const response = await axios.get(cleanUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 10000
        });
        const html = response.data;
        const patterns = [
            /\"userID\":\"(\d+)\"/,
            /\"profile_id\":\"(\d+)\"/,
            /\"id\":\"(\d+)\",\"name\":/,
            /profile\.php\?id=(\d+)/
        ];
        for (const pattern of patterns) {
            const found = html.match(pattern);
            if (found && found[1]) return { success: true, uid: found[1], method: 'html_parse' };
        }
    } catch (err) {}

    return { success: false, error: 'Không thể tìm thấy UID. Có thể tài khoản ở chế độ riêng tư hoặc link không hợp lệ.' };
}

// Hàm trích xuất username từ link
function extractUsername(url) {
    const patterns = [
        /facebook\.com\/(?!profile\.php)(?!photo\.php)(?!watch)([^\/?&]+)/,
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

// API lấy UID
app.post('/api/get-uid', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ success: false, error: 'Vui lòng nhập link Facebook' });
    }
    try {
        const result = await extractUID(url);
        if (result.success) {
            res.json({ success: true, uid: result.uid, method: result.method, url });
        } else {
            res.status(404).json({ success: false, error: result.error });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: 'Lỗi máy chủ: ' + error.message });
    }
});

// API batch
app.post('/api/batch-get-uid', async (req, res) => {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls)) {
        return res.status(400).json({ success: false, error: 'Cần mảng URLs' });
    }
    const results = [];
    for (const url of urls.slice(0, 20)) {
        const result = await extractUID(url);
        results.push({ url, ...result });
    }
    res.json({ success: true, results });
});

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'OK' }));

module.exports = app;
