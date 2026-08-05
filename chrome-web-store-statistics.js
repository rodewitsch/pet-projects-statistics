async function main(args) {
    const TELEGRAM_BOT_TOKEN = args.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
    const TELEGRAM_CHAT_ID = args.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
    
    const rawIds = (args.EXTENSION_IDS || process.env.EXTENSION_IDS || '');
    const EXTENSION_IDS = rawIds
        .replace(/["'`]/g, '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);
    
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || EXTENSION_IDS.length === 0) {
        return { 
            statusCode: 400, 
            body: JSON.stringify({ error: 'Missing credentials or extension IDs' }) 
        };
    }

    try {
        const stats = [];
        
        for (const extId of EXTENSION_IDS) {
            const extStats = await scrapeExtensionStats(extId);
            if (extStats) {
                stats.push(extStats);
            }
        }
        
        stats.sort((a, b) => (b.users || 0) - (a.users || 0));
        
        const message = formatChromeStatsMessage(stats);
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, message);

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, stats: stats })
        };

    } catch (error) {
        console.error('Error:', error.message);
        
        try {
            await sendTelegramMessage(
                TELEGRAM_BOT_TOKEN, 
                TELEGRAM_CHAT_ID, 
                `❌ Chrome stats error: ${error.message}`
            );
        } catch (e) {
            console.error('Telegram error:', e);
        }

        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: error.message })
        };
    }
}

async function scrapeExtensionStats(extensionId) {
    try {
        const oldUrl = `https://chrome.google.com/webstore/detail/${extensionId}`;
        const response = await fetch(oldUrl, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const html = await response.text();
        
        const stats = {
            id: extensionId,
            name: extensionId,
            users: 0,
            rating: 0,
            ratingCount: 0,
            storeUrl: `https://chromewebstore.google.com/detail/${extensionId}`
        };
        
        // Название
        const titleMatch = html.match(/<title>([^<]*)<\/title>/);
        if (titleMatch) {
            let title = titleMatch[1]
                .replace(/\s*-\s*Chrome Web Store\s*$/, '')
                .replace(/^Chrome Web Store\s*-\s*/, '')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .trim();
            
            if (title && title !== 'Chrome Web Store') {
                stats.name = title;
            }
        }
        
        // Пользователи
        const userMatch = html.match(/>(\d[\d,]*)\+?\s*users?</i) || 
                         html.match(/(\d[\d,]*)\s*users?</i);
        if (userMatch) {
            stats.users = parseInt(userMatch[1].replace(/,/g, ''));
        }
        
        // Рейтинг
        const ratingMatch = html.match(/rating\s+(\d+\.?\d*)\s+out of 5/i);
        if (ratingMatch) {
            stats.rating = parseFloat(ratingMatch[1]);
        }
        
        // Количество оценок
        const countMatch = html.match(/(\d[\d,]*)\s*(?:ratings?|reviews?)/i);
        if (countMatch) {
            stats.ratingCount = parseInt(countMatch[1].replace(/,/g, ''));
        }
        
        return stats;
        
    } catch (error) {
        console.error(`Failed: ${extensionId}`, error.message);
        return {
            id: extensionId,
            name: extensionId,
            users: 0,
            rating: 0,
            ratingCount: 0,
            storeUrl: `https://chromewebstore.google.com/detail/${extensionId}`
        };
    }
}

function formatChromeStatsMessage(stats) {
    // Минское время (UTC+3)
    const now = new Date();
    const minskTime = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    
    const d = String(minskTime.getUTCDate()).padStart(2, '0');
    const m = String(minskTime.getUTCMonth() + 1).padStart(2, '0');
    const y = minskTime.getUTCFullYear();
    const h = String(minskTime.getUTCHours()).padStart(2, '0');
    const min = String(minskTime.getUTCMinutes()).padStart(2, '0');
    
    let message = '<b>🔌 Chrome Web Store Statistics</b>\n';
    message += '━━━━━━━━━━━━━━━━━\n\n';

    if (stats.length > 0) {
        const totalUsers = stats.reduce((sum, s) => sum + (s.users || 0), 0);
        
        message += `<b>📊 Summary</b>\n`;
        message += `├ Extensions: ${stats.length}\n`;
        message += `└ Total users: ${formatNumber(totalUsers)}\n\n`;
        
        message += `<b>📈 Extensions</b>\n`;
        
        stats.forEach((stat, index) => {
            const ratingStars = stat.rating > 0 ? 
                '★'.repeat(Math.round(stat.rating)) + '☆'.repeat(5 - Math.round(stat.rating)) : 
                '';
            
            message += `\n${index + 1}. <a href="${stat.storeUrl}">${stat.name}</a>\n`;
            message += `├ 👥 Users: <b>${formatNumber(stat.users)}</b>\n`;
            
            if (stat.rating > 0) {
                message += `├ ⭐ ${ratingStars}`;
                if (stat.ratingCount > 0) {
                    message += ` (${formatNumber(stat.ratingCount)})`;
                }
                message += `\n`;
            }
        });
        
    } else {
        message += '❌ No data available\n';
    }

    message += '\n━━━━━━━━━━━━━━━━━';
    message += `\n⏰ Updated: ${d}.${m}.${y}, ${h}:${min} MSK`;

    return message;
}

function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
}

async function sendTelegramMessage(botToken, chatId, text) {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        })
    });

    if (!response.ok) {
        const error = await response.text();
        console.error('Telegram error:', error);
        
        const plainText = text.replace(/<[^>]*>/g, '');
        const fallbackResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: plainText,
                disable_web_page_preview: true
            })
        });
        return await fallbackResponse.json();
    }

    return await response.json();
}

exports.main = main;