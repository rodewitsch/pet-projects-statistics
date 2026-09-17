// packages/digitalocean-functions/statistics/index.js

async function main(args) {
    const TELEGRAM_BOT_TOKEN = args.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
    const TELEGRAM_CHAT_ID = args.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
    const ZEPP_EMAIL = args.ZEPP_EMAIL || process.env.ZEPP_EMAIL;
    const ZEPP_PASSWORD = args.ZEPP_PASSWORD || process.env.ZEPP_PASSWORD;
    const USER_ID = args.USER_ID || process.env.USER_ID;
    // Optional pin for the watchface statistics `type`. When set, the auto-probe
    // is skipped (see detectWatchfaceStatistics).
    const WATCHFACE_TYPE = args.ZEPP_WATCHFACE_TYPE || process.env.ZEPP_WATCHFACE_TYPE;

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

        const apps = extractItems(
            await getStatistics(tokenInfo, USER_ID, startTime, endTime, STATS_TYPE_APP)
        );

        // Watchface statistics live behind an undocumented `type` value, so it is
        // probed (or pinned via ZEPP_WATCHFACE_TYPE). A probe failure must never
        // break the report - the app section is still worth sending.
        let watchfaces = null;
        let watchfaceType = null;
        try {
            const detected = await detectWatchfaceStatistics(
                tokenInfo, USER_ID, startTime, endTime, apps.items, WATCHFACE_TYPE
            );
            if (detected) {
                watchfaces = extractItems(detected.response);
                watchfaceType = detected.type;
            }
        } catch (e) {
            console.error(`[watchface] detection failed: ${e.message}`);
        }

        const message = formatStatisticsMessage(apps, watchfaces, startDate, endDate);
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, message);

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, watchfaceType: watchfaceType })
        };

    } catch (error) {
        const verbose = error && error.stack ? `${error.message}\n${error.stack}` : String(error);
        console.error('Error:', verbose);
        
        try {
            await sendTelegramMessageSimple(
                TELEGRAM_BOT_TOKEN, 
                TELEGRAM_CHAT_ID, 
                `❌ Zepp stats error: ${error.message}`
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
const STATS_PER_PAGE = 50;

// The `type` query param selects which catalogue the statistics cover.
// 4 = Zepp OS apps (verified against the live account). The watchface value is
// not documented anywhere and could not be derived from the console bundle, so
// it is probed at runtime (see detectWatchfaceStatistics).
const STATS_TYPE_APP = 4;
const WATCHFACE_TYPE_CANDIDATES = [1, 2, 3, 5, 6];

// Probing multiplies the number of stats calls per run, so the first host that
// answers is pinned for the rest of the invocation. Without this every probe
// would walk the whole STATISTICS_HOSTS list, including the China hosts that
// time out from the DigitalOcean sandbox.
let preferredStatsHost = null;

function buildStatisticsPath(userId, type, startTime, endTime, perPage) {
    return `/market/open/statistics?userid=${userId}&page=1&per_page=${perPage}&type=${type}&start_time=${startTime}&end_time=${endTime}`;
}

async function getStatistics(appToken, userId, startTime, endTime, type, perPage) {
    const path = buildStatisticsPath(userId, type, startTime, endTime, perPage || STATS_PER_PAGE);
    const headers = {
        'accept': 'application/json, text/plain, */*',
        'apptoken': appToken,
        'Referer': 'https://console.zepp.com/'
    };

    // Pinned host first, then the remaining region list.
    const hosts = preferredStatsHost
        ? [preferredStatsHost].concat(STATISTICS_HOSTS.filter((host) => host !== preferredStatsHost))
        : STATISTICS_HOSTS;

    let lastError;
    for (const host of hosts) {
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
            const count = data && Array.isArray(data.data) ? data.data.length : 0;
            preferredStatsHost = host;
            console.error(`[stats] type=${type} served from ${host} (${count} items)`);
            return data;
        } catch (e) {
            lastError = e;
            if (preferredStatsHost === host) preferredStatsHost = null;
            console.error(`getStatistics (type=${type}) failed on ${host}: ${e.message}`);
        }
    }

    throw lastError;
}

function extractItems(response) {
    const items = response && Array.isArray(response.data) ? response.data : [];
    const total = response && response.total ? response.total : items.length;
    return { total: total, items: items };
}

// App rows and watchface rows are not guaranteed to share field names, so every
// known spelling is accepted instead of trusting a single one.
function getItemName(item) {
    return item.name || item.app_name || item.watch_name || 'Unknown';
}

function getItemDownloads(item) {
    return item.downloads || item.download_count || item.download_num || 0;
}

function getItemOnlineDate(item) {
    return item.online || item.online_time || item.release_time;
}

function isFreeItem(item) {
    const value = item.is_free;
    return value === true || value === 'true' || value === 1 || value === '1';
}

function countItemCountries(item) {
    if (!item.country) return 0;
    return item.country.split(',').length;
}

function sumDownloads(stats) {
    if (!stats || !Array.isArray(stats.items)) return 0;
    return stats.items.reduce((sum, item) => sum + getItemDownloads(item), 0);
}

function itemIdentity(item, index) {
    if (!item) return `#${index}`;
    return String(item.id || item.app_id || item.watchface_id || item.name || `#${index}`);
}

/**
 * Finds the statistics `type` that returns watchfaces.
 *
 * The endpoint echoes whichever catalogue the `type` selects, so a probe answer is
 * rejected when every one of its items is already in the app list (the same
 * catalogue can't be the watchface one). The probe uses the real page size, so the
 * winning response is reused as the final data and no second call is made.
 */
async function detectWatchfaceStatistics(appToken, userId, startTime, endTime, appItems, pinnedType) {
    const appIdentities = new Set((appItems || []).map((item, index) => itemIdentity(item, index)));

    if (pinnedType) {
        const response = await getStatistics(appToken, userId, startTime, endTime, pinnedType);
        const items = extractItems(response).items;
        console.error(`[watchface] pinned type=${pinnedType} -> ${items.length} items`);
        return items.length > 0 ? { type: Number(pinnedType), response: response } : null;
    }

    for (const type of WATCHFACE_TYPE_CANDIDATES) {
        let response;
        try {
            response = await getStatistics(appToken, userId, startTime, endTime, type);
        } catch (e) {
            console.error(`[watchface] type=${type} -> request failed: ${e.message}`);
            continue;
        }

        const items = extractItems(response).items;
        console.error(`[watchface] type=${type} -> ${items.length} items`);

        if (items.length === 0) continue;

        if (items.every((item, index) => appIdentities.has(itemIdentity(item, index)))) {
            console.error(`[watchface] type=${type} -> same catalogue as apps, skipping`);
            continue;
        }

        // A type that ignores the filter would return both catalogues, so app rows
        // are dropped instead of being rendered twice.
        const watchfaceOnly = items.filter((item, index) => !appIdentities.has(itemIdentity(item, index)));
        if (watchfaceOnly.length === 0) continue;

        console.error(`[watchface] watchface statistics served by type=${type}`);
        return {
            type: type,
            response: { ...response, total: watchfaceOnly.length, data: watchfaceOnly }
        };
    }

    console.error('[watchface] no candidate type returned watchface data');
    return null;
}

function formatItemBlock(item, index) {
    const name = escapeMarkdown(getItemName(item));
    const onlineDate = formatOnlineDate(getItemOnlineDate(item));
    const priceLabel = isFreeItem(item) ? '🆓 Free' : '💰 Paid';
    const countriesCount = countItemCountries(item);

    let block = `\n*${index + 1}\\. ${name}*\n`;
    block += `├ 📥 Downloads: *${escapeMarkdown(formatExactNumber(getItemDownloads(item)))}*\n`;
    if (onlineDate !== 'Unknown') {
        block += `├ 📅 Published: ${escapeMarkdown(onlineDate)}\n`;
    }
    block += `├ ${priceLabel}\n`;
    if (countriesCount > 0) {
        block += `└ 🌍 ${countriesCount} countries\n`;
    }
    return block;
}

function formatSection(heading, label, stats) {
    if (!stats || stats.items.length === 0) {
        return `❌ No ${label} data for this period\n`;
    }

    let section = `${heading}\n`;
    stats.items.forEach((item, index) => {
        section += formatItemBlock(item, index);
    });
    return section;
}

function formatStatisticsMessage(apps, watchfaces, startDate, endDate) {
    const startFormatted = formatMinskDateDisplay(startDate);
    const endFormatted = formatMinskDateDisplay(endDate);

    let message = '⌚️ *Zepp Statistics*\n';
    message += `📅 ${escapeMarkdown(startFormatted)} \\- ${escapeMarkdown(endFormatted)}\n`;
    message += '━━━━━━━━━━━━━━━━━\n\n';

    message += `📊 *Summary*\n`;
    message += `├ Apps: ${apps.total}\n`;
    if (watchfaces) {
        message += `├ App downloads: ${escapeMarkdown(formatExactNumber(sumDownloads(apps)))}\n`;
        message += `├ Watchfaces: ${watchfaces.total}\n`;
        message += `└ Watchface downloads: ${escapeMarkdown(formatExactNumber(sumDownloads(watchfaces)))}\n`;
    } else {
        message += `└ App downloads: ${escapeMarkdown(formatExactNumber(sumDownloads(apps)))}\n`;
    }
    message += '\n';

    message += formatSection('📈 *Apps Performance*', 'apps', apps) + '\n';
    if (watchfaces && watchfaces.items.length > 0) {
        message += formatSection('⌚️ *Watchfaces Performance*', 'watchfaces', watchfaces) + '\n';
    }

    const minskNow = getMinskTime();
    const updateTime = `${String(minskNow.getUTCDate()).padStart(2, '0')}.${String(minskNow.getUTCMonth() + 1).padStart(2, '0')}.${minskNow.getUTCFullYear()}, ${String(minskNow.getUTCHours()).padStart(2, '0')}:${String(minskNow.getUTCMinutes()).padStart(2, '0')}`;

    message += '━━━━━━━━━━━━━━━━━';
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

// Exact download counts - no K/M abbreviation: 1000 -> "1,000", 1234567 -> "1,234,567".
// A comma is NOT a MarkdownV2 reserved character, but the value is still passed
// through escapeMarkdown() at the call sites as a safety net. The old abbreviation
// ("1.0K") contained a dot, which MarkdownV2 rejects unless escaped, so Telegram
// refused the whole message and the plain-text fallback mangled it instead.
function formatExactNumber(num) {
    const value = Number(num);
    if (!Number.isFinite(value)) return '0';
    return Math.trunc(value).toLocaleString('en-US');
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

// The fallback request is sent WITHOUT parse_mode, so only the MarkdownV2 syntax
// has to go - never the content. The previous version also stripped '.', '-', '!'
// and friends, which mangled dates ("16.03.2026 - 12.09.2026" became
// "17032026  13092026") and turned "1.0K" into "10K" in the chat.
function toPlainText(text) {
    // Escaped character -> keep the character itself; formatting delimiter -> drop it.
    return String(text).replace(/\\(.)|[*_`~|]/g, (match, escaped) => escaped || '');
}

async function sendTelegramMessageSimple(botToken, chatId, text) {
    const plainText = toPlainText(text);
    
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