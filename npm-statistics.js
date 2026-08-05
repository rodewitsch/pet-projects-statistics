// packages/digitalocean-functions/npm-stats/index.js

async function main(args) {
    const TELEGRAM_BOT_TOKEN = args.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
    const TELEGRAM_CHAT_ID = args.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
    const NPM_USERNAME = args.NPM_USERNAME || process.env.NPM_USERNAME;
    
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing credentials' }) };
    }

    try {
        // Получаем список пакетов пользователя
        const packages = await getNpmPackages(NPM_USERNAME);
        console.log(`Found ${packages.length} packages`);
        
        // Получаем статистику для каждого пакета
        const stats = [];
        for (const pkg of packages) {
            const pkgStats = await getPackageStats(pkg.name);
            stats.push({
                name: pkg.name,
                version: pkg.version,
                description: pkg.description,
                downloads: pkgStats.downloads || 0,
                weeklyDownloads: pkgStats.weeklyDownloads || 0,
                monthlyDownloads: pkgStats.monthlyDownloads || 0,
                url: `https://www.npmjs.com/package/${pkg.name}`
            });
        }
        
        // Сортируем по скачиваниям
        stats.sort((a, b) => b.downloads - a.downloads);
        
        const message = formatNpmStatsMessage(stats);
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, message);

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, stats: stats })
        };

    } catch (error) {
        console.error('Error:', error.message);
        
        try {
            await sendTelegramMessageSimple(
                TELEGRAM_BOT_TOKEN, 
                TELEGRAM_CHAT_ID, 
                `❌ NPM stats error: ${error.message}`
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

async function getNpmPackages(username) {
    try {
        // API для поиска пакетов по maintainer
        const response = await fetch(
            `https://registry.npmjs.org/-/v1/search?text=maintainer:${username}&size=250`,
            {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                }
            }
        );

        if (!response.ok) {
            throw new Error(`NPM search failed: ${response.status}`);
        }

        const data = await response.json();
        return (data.objects || []).map(obj => obj.package);
    } catch (error) {
        console.error('Failed to get packages:', error.message);
        return [];
    }
}

async function getPackageStats(packageName) {
    try {
        // Получаем общую статистику
        const totalResponse = await fetch(
            `https://api.npmjs.org/downloads/point/2015-01-01:${new Date().toISOString().split('T')[0]}/${packageName}`,
            {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            }
        );

        let downloads = 0;
        if (totalResponse.ok) {
            const totalData = await totalResponse.json();
            downloads = totalData.downloads || 0;
        }

        // Получаем статистику за последнюю неделю
        const lastWeek = new Date();
        lastWeek.setDate(lastWeek.getDate() - 7);
        const weekResponse = await fetch(
            `https://api.npmjs.org/downloads/point/${lastWeek.toISOString().split('T')[0]}:${new Date().toISOString().split('T')[0]}/${packageName}`,
            {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            }
        );

        let weeklyDownloads = 0;
        if (weekResponse.ok) {
            const weekData = await weekResponse.json();
            weeklyDownloads = weekData.downloads || 0;
        }

        // За последний месяц
        const lastMonth = new Date();
        lastMonth.setMonth(lastMonth.getMonth() - 1);
        const monthResponse = await fetch(
            `https://api.npmjs.org/downloads/point/${lastMonth.toISOString().split('T')[0]}:${new Date().toISOString().split('T')[0]}/${packageName}`,
            {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            }
        );

        let monthlyDownloads = 0;
        if (monthResponse.ok) {
            const monthData = await monthResponse.json();
            monthlyDownloads = monthData.downloads || 0;
        }

        return {
            downloads,
            weeklyDownloads,
            monthlyDownloads
        };
    } catch (error) {
        console.error(`Failed to get stats for ${packageName}:`, error.message);
        return { downloads: 0, weeklyDownloads: 0, monthlyDownloads: 0 };
    }
}

function getMinskTime() {
    const now = new Date();
    return new Date(now.getTime() + 3 * 60 * 60 * 1000);
}

function formatNpmStatsMessage(stats) {
    const minskNow = getMinskTime();
    const d = String(minskNow.getUTCDate()).padStart(2, '0');
    const m = String(minskNow.getUTCMonth() + 1).padStart(2, '0');
    const y = minskNow.getUTCFullYear();
    const h = String(minskNow.getUTCHours()).padStart(2, '0');
    const min = String(minskNow.getUTCMinutes()).padStart(2, '0');
    
    let message = '<b>📦 NPM Packages Statistics</b>\n';
    message += '━━━━━━━━━━━━━━━━━\n\n';

    if (stats.length > 0) {
        const totalDownloads = stats.reduce((sum, s) => sum + (s.downloads || 0), 0);
        const totalWeekly = stats.reduce((sum, s) => sum + (s.weeklyDownloads || 0), 0);
        
        message += `<b>📊 Summary</b>\n`;
        message += `├ Packages: ${stats.length}\n`;
        message += `├ Total downloads: ${formatNumber(totalDownloads)}\n`;
        message += `└ Weekly downloads: ${formatNumber(totalWeekly)}\n\n`;
        
        message += `<b>📈 Packages</b>\n`;
        
        stats.forEach((stat, index) => {
            message += `\n${index + 1}. <a href="${stat.url}">${stat.name}</a>\n`;
            message += `├ 📥 Total: <b>${formatNumber(stat.downloads)}</b>\n`;
            message += `├ 📅 Week: ${formatNumber(stat.weeklyDownloads)}\n`;
            message += `├ 📅 Month: ${formatNumber(stat.monthlyDownloads)}\n`;
            message += `└ 📦 v${stat.version || 'N/A'}\n`;
        });
        
    } else {
        message += '❌ No packages found\n';
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
    try {
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
            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: plainText,
                    disable_web_page_preview: true
                })
            });
        }

        return await response.json();
    } catch (error) {
        console.error('Send error:', error);
        return null;
    }
}

async function sendTelegramMessageSimple(botToken, chatId, text) {
    const plainText = text.replace(/<[^>]*>/g, '');
    
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text: plainText,
            disable_web_page_preview: true
        })
    });
}

exports.main = main;