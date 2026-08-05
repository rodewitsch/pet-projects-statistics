// packages/digitalocean-functions/statistics/index.js

async function main(args) {
    const TELEGRAM_BOT_TOKEN = args.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
    const TELEGRAM_CHAT_ID = args.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
    const ZEPP_EMAIL = args.ZEPP_EMAIL || process.env.ZEPP_EMAIL;
    const ZEPP_PASSWORD = args.ZEPP_PASSWORD || process.env.ZEPP_PASSWORD;
    const USER_ID = args.USER_ID || process.env.USER_ID;

    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing credentials' }) };
    }

    try {
        const accessCode = await getAuthorizationCode(ZEPP_EMAIL, ZEPP_PASSWORD);
        const tokenInfo = await getAccessToken(accessCode);
        
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 180);
        
        const startTime = formatDate(startDate);
        const endTime = formatDate(endDate);
        
        const statisticsData = await getStatistics(tokenInfo, USER_ID, startTime, endTime);
        const message = formatStatisticsMessage(statisticsData, startDate, endDate);
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, message);

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true })
        };

    } catch (error) {
        console.error('Error:', error.message);
        
        try {
            await sendTelegramMessageSimple(
                TELEGRAM_BOT_TOKEN, 
                TELEGRAM_CHAT_ID, 
                `❌ Zepp apps stats error: ${error.message}`
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

function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatDateDisplay(date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}.${month}.${year}`;
}

function getMinskTime() {
    const now = new Date();
    // Минск = UTC+3
    return new Date(now.getTime() + 3 * 60 * 60 * 1000);
}

function formatMinskDateDisplay(date) {
    const minskDate = new Date(date.getTime() + 3 * 60 * 60 * 1000);
    const day = String(minskDate.getUTCDate()).padStart(2, '0');
    const month = String(minskDate.getUTCMonth() + 1).padStart(2, '0');
    const year = minskDate.getUTCFullYear();
    return `${day}.${month}.${year}`;
}

async function getAuthorizationCode(email, password) {
    const response = await fetch(
        `https://api-user.huami.com/registrations/${encodeURIComponent(email)}/tokens`,
        {
            method: 'POST',
            headers: {
                'accept': 'application/json, text/plain, */*',
                'accept-language': 'zh',
                'app_name': 'com.huami.webapp',
                'content-type': 'application/x-www-form-urlencoded',
                'lang': 'en',
                'Referer': 'https://user.zepp.com/'
            },
            body: new URLSearchParams({
                client_id: 'HuaMi',
                country_code: 'US',
                json_response: 'true',
                name: email,
                password: password,
                redirect_uri: 'https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html',
                state: 'REDIRECTION',
                token: 'access'
            }).toString()
        }
    );

    if (!response.ok) throw new Error(`Auth step 1 failed: ${response.status}`);
    const data = await response.json();
    if (!data.access) throw new Error('No access code in response');
    return data.access;
}

async function getAccessToken(authCode) {
    const response = await fetch('https://account.huami.com/v2/client/login', {
        method: 'POST',
        headers: {
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'lang': 'en',
            'Referer': 'https://user.zepp.com/'
        },
        body: new URLSearchParams({
            allow_registration: 'false',
            app_name: 'com.huami.webapp',
            app_version: '4.3.0',
            code: authCode,
            country_code: 'RU',
            device_id: '02:00:00:00:00:00',
            device_model: 'web',
            dn: 'account.huami.com,api-user.huami.com,auth.huami.com,api-mifit.huami.com,api-open.huami.com',
            grant_type: 'access_token',
            third_name: 'huami'
        }).toString()
    });

    if (!response.ok) throw new Error(`Auth step 2 failed: ${response.status}`);
    const data = await response.json();
    if (!data.token_info || !data.token_info.app_token) throw new Error('No app_token');
    return data.token_info.app_token;
}

async function getStatistics(appToken, userId, startTime, endTime) {
    const url = `https://api-mifit-cn3.zepp.com/market/open/statistics?userid=${userId}&page=1&per_page=50&type=4&start_time=${startTime}&end_time=${endTime}`;
    
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'accept': 'application/json, text/plain, */*',
            'apptoken': appToken,
            'Referer': 'https://console.zepp.com/'
        }
    });

    if (!response.ok) throw new Error(`Stats request failed: ${response.status}`);
    return await response.json();
}

function formatStatisticsMessage(data, startDate, endDate) {
    const startFormatted = formatMinskDateDisplay(startDate);
    const endFormatted = formatMinskDateDisplay(endDate);
    
    let message = '⌚️ *Zepp Apps Statistics*\n';
    message += `📅 ${escapeMarkdown(startFormatted)} \\- ${escapeMarkdown(endFormatted)}\n`;
    message += '━━━━━━━━━━━━━━━━━\n\n';

    if (data && data.data && data.data.length > 0) {
        const totalApps = data.total || data.data.length;
        const totalDownloads = data.data.reduce((sum, app) => sum + (app.downloads || 0), 0);
        
        message += `📊 *Summary*\n`;
        message += `├ Total apps: ${totalApps}\n`;
        message += `└ Total downloads: ${formatNumber(totalDownloads)}\n\n`;
        
        message += `📈 *Apps Performance*\n`;
        
        data.data.forEach((app, index) => {
            const name = escapeMarkdown(app.name || 'Unknown');
            const onlineDate = formatOnlineDate(app.online);
            
            const isFree = app.is_free === true || app.is_free === 'true' || app.is_free === 1;
            const priceLabel = isFree ? '🆓 Free' : '💰 Paid';
            
            message += `\n*${index + 1}\\. ${name}*\n`;
            message += `├ 📥 Downloads: *${formatNumber(app.downloads || 0)}*\n`;
            if (onlineDate !== 'Unknown') {
                message += `├ 📅 Published: ${escapeMarkdown(onlineDate)}\n`;
            }
            message += `├ ${priceLabel}\n`;
            
            if (app.country) {
                const countriesCount = app.country.split(',').length;
                message += `└ 🌍 ${countriesCount} countries\n`;
            }
        });
        
    } else {
        message += '❌ No apps data for this period\n';
    }

    const minskNow = getMinskTime();
    const updateTime = `${String(minskNow.getUTCDate()).padStart(2, '0')}.${String(minskNow.getUTCMonth() + 1).padStart(2, '0')}.${minskNow.getUTCFullYear()}, ${String(minskNow.getUTCHours()).padStart(2, '0')}:${String(minskNow.getUTCMinutes()).padStart(2, '0')}`;
    
    message += '\n━━━━━━━━━━━━━━━━━';
    message += `\n⏰ Updated: ${escapeMarkdown(updateTime)} MSK`;

    return message;
}

function formatOnlineDate(dateString) {
    if (!dateString) return 'Unknown';
    
    try {
        const date = new Date(dateString);
        if (!isNaN(date.getTime())) {
            return formatMinskDateDisplay(date);
        }
        
        const str = dateString.toString();
        
        if (str.includes('T')) {
            const datePart = str.split('T')[0];
            
            if (datePart.length === 8) {
                const year = datePart.substring(0, 4);
                const month = datePart.substring(4, 6);
                const day = datePart.substring(6, 8);
                
                return `${day}.${month}.${year}`;
            }
        }
        
        return 'Unknown';
    } catch (error) {
        console.error('Date parsing error for:', dateString, error);
        return 'Unknown';
    }
}

function escapeMarkdown(text) {
    if (!text) return '';
    return text.toString().replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function formatNumber(num) {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1) + 'M';
    } else if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
}

async function sendTelegramMessage(botToken, chatId, text) {
    try {
        const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'MarkdownV2',
                disable_web_page_preview: true
            })
        });

        if (!response.ok) {
            const error = await response.json();
            console.error('Telegram Markdown error:', error);
            return await sendTelegramMessageSimple(botToken, chatId, text);
        }

        return await response.json();
    } catch (error) {
        console.error('Send error:', error);
        return await sendTelegramMessageSimple(botToken, chatId, text);
    }
}

async function sendTelegramMessageSimple(botToken, chatId, text) {
    const plainText = text
        .replace(/\*/g, '')
        .replace(/`/g, '')
        .replace(/\\/g, '')
        .replace(/[_\[\]()~>#+\-=|{}.!]/g, '');
    
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text: plainText,
            disable_web_page_preview: true
        })
    });

    return await response.json();
}

exports.main = main;