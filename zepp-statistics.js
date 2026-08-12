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
        const verbose = error && error.stack ? `${error.message}\n${error.stack}` : String(error);
        console.error('Error:', verbose);
        
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

const https = require('https');
const http = require('http');

const FETCH_TIMEOUT_MS = 10000;   // per attempt
const FETCH_MAX_RETRIES = 3;      // total attempts

const RETRYABLE_STATUS = [408, 425, 429, 500, 502, 503, 504];

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Minimal fetch-compatible response built on the Node http/https modules.
// Using the built-in modules instead of undici's global fetch() is far more
// reliable inside the DigitalOcean Functions sandbox and yields precise
// error codes (ENOTFOUND, ECONNREFUSED, ECONNRESET, CERT_HAS_EXPIRED, ...)
// instead of a bare 'TypeError: fetch failed'.
async function httpsFetch(url, options = {}) {
    const u = new URL(url);
    const transport = u.protocol === 'http:' ? http : https;

    const headers = { ...(options.headers || {}) };

    let bodyBuffer = null;
    if (options.body) {
        bodyBuffer = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
        headers['content-length'] = bodyBuffer.length;
    }

    return new Promise((resolve, reject) => {
        const req = transport.request(
            {
                method: options.method || 'GET',
                hostname: u.hostname,
                port: u.port || (u.protocol === 'http:' ? 80 : 443),
                path: u.pathname + u.search,
                headers,
                rejectUnauthorized: true
            },
            (res) => {
                let chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    resolve({
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        status: res.statusCode,
                        statusText: res.statusMessage,
                        async json() {
                            try { return JSON.parse(text); }
                            catch (e) { throw new Error(`Invalid JSON from ${url}: ${text.slice(0,200)}`); }
                        },
                        async text() { return text; }
                    });
                });
            }
        );

        req.setTimeout(FETCH_TIMEOUT_MS, () => {
            req.destroy(new Error(`Request timeout (${FETCH_TIMEOUT_MS}ms) for ${u.hostname}`));
        });

        req.on('error', (err) => {
            reject(err);
        });

        if (bodyBuffer) req.write(bodyBuffer);
        req.end();
    });
}

/**
 * fetch() with timeout + retry on transient failures.
 * Logs the failing URL and underlying cause, so 'fetch failed' is never silent.
 */
async function fetchWithRetry(url, options = {}) {
    const maxRetries = options.maxRetries || FETCH_MAX_RETRIES;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const res = await httpsFetch(url, options);

            // Retry on transient server status codes too
            if (RETRYABLE_STATUS.includes(res.status) && attempt < maxRetries) {
                console.error(`Retryable status ${res.status} for ${url} (attempt ${attempt}/${maxRetries})`);
                await delay(500 * attempt);
                continue;
            }

            return res;
        } catch (e) {
            lastError = e;
            console.error(
                `fetch failed for ${url} (attempt ${attempt}/${maxRetries}): ${e.name || 'Error'}: ${e.message}`
            );

            if (attempt < maxRetries) {
                await delay(500 * attempt);
            }
        }
    }

    throw lastError;
}

async function getAuthorizationCode(email, password) {
    const response = await fetchWithRetry(
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
    const response = await fetchWithRetry('https://account.huami.com/v2/client/login', {
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

// Region hosts for the Zepp market/statistics API. The account serves data on
// the US/international host, and egress from the DigitalOcean sandbox to the
// China (-cn*) hosts times out at the TCP level, so the non-China hosts go
// first and the China hosts stay as a fallback.
const STATISTICS_HOSTS = [
    'api-mifit-us.zepp.com',
    'api-mifit.zepp.com',
    'api-mifit-cn3.zepp.com',
    'api-mifit-cn.zepp.com',
    'api-mifit-cn2.zepp.com'
];

// Statistics host is already the primary data source; keep per-host calls fast
// so a stack of dead hosts doesn't burn the whole 60s function budget.
const STATS_ATTEMPTS = 2;

async function getStatistics(appToken, userId, startTime, endTime) {
    const path = `/market/open/statistics?userid=${userId}&page=1&per_page=50&type=4&start_time=${startTime}&end_time=${endTime}`;
    const headers = {
        'accept': 'application/json, text/plain, */*',
        'apptoken': appToken,
        'Referer': 'https://console.zepp.com/'
    };

    let lastError;
    for (const host of STATISTICS_HOSTS) {
        const url = `https://${host}${path}`;
        try {
            const response = await fetchWithRetry(url, {
                method: 'GET',
                headers,
                maxRetries: STATS_ATTEMPTS
            });
            if (!response.ok) {
                throw new Error(`Stats request failed: ${response.status} (${host})`);
            }
            const data = await response.json();
            console.error(`[stats] data served from ${host} (${data.data ? data.data.length : 0} apps)`);
            return data;
        } catch (e) {
            lastError = e;
            console.error(`getStatistics failed on ${host}: ${e.message}`);
        }
    }

    throw lastError;
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
        const response = await fetchWithRetry(`https://api.telegram.org/bot${botToken}/sendMessage`, {
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
    
    const response = await fetchWithRetry(`https://api.telegram.org/bot${botToken}/sendMessage`, {
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