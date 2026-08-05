# Pet Projects Statistics

Serverless functions (DigitalOcean Functions) that collect statistics for pet projects and send reports to Telegram. Each function gathers data from its own source, builds a formatted message, and sends it via the Telegram Bot API.

## Contents

| File | Data source | What it collects |
|------|-------------|------------------|
| `chrome-web-store-statistics.js` | Chrome Web Store | Users, rating, and review count of Chrome extensions |
| `npm-statistics.js` | npm registry | npm package downloads (total / weekly / monthly) |
| `zepp-statistics.js` | Zepp / Huami API | Statistics for Zepp smartwatch apps |

All functions share the same shape: they export `main(args)` and return an HTTP response object in the DigitalOcean Functions format.

---

## Common conventions

- **Input parameters**: passed via `args` (when the function is invoked) or via `process.env` environment variables. `args` takes precedence.
- **Telegram auth**: a bot token in `TELEGRAM_BOT_TOKEN` and a chat ID in `TELEGRAM_CHAT_ID`.
- **Time**: all timestamps are generated in Minsk time (UTC+3) and labeled `MSK`.
- **Number formatting**: large numbers are shortened — `1,000,000` → `1.0M`, `10,000` → `10.0K`.
- **Error handling**: on failure the function sends a `❌ ... error: <message>` message to Telegram and returns `statusCode: 500`.

---

## 1. Chrome Web Store Statistics — `chrome-web-store-statistics.js`

Collects statistics for one or more Chrome extensions: user count, average rating, and number of reviews. Extensions are sorted by user count in descending order.

### Parameters

| Parameter | Environment variable | Required | Description |
|-----------|----------------------|:--------:|-------------|
| `TELEGRAM_BOT_TOKEN` | `TELEGRAM_BOT_TOKEN` | ✅ | Telegram bot token |
| `TELEGRAM_CHAT_ID` | `TELEGRAM_CHAT_ID` | ✅ | Chat ID to send the report to |
| `EXTENSION_IDS` | `EXTENSION_IDS` | ✅ | Comma-separated list of extension IDs (quotes are stripped automatically) |

### Example invocation

```json
{
  "TELEGRAM_BOT_TOKEN": "123456:ABC-DEF...",
  "TELEGRAM_CHAT_ID": "-1001234567890",
  "EXTENSION_IDS": "abcdefghijklmnopqrstuvwxyz123456,zyxwvutsrqponmlkjihgfedcba654321"
}
```

### Data source

- Fetches the extension page: `https://chrome.google.com/webstore/detail/<id>`
- Parses HTML: title (`<title>`), user count (`X users`), rating (`X out of 5`), and review count (`X ratings`).
- Extension store link: `https://chromewebstore.google.com/detail/<id>`

### Report format (Telegram HTML)

- Header `🔌 Chrome Web Store Statistics`
- Summary: number of extensions and total user count
- Per extension: name (link), users, star rating `★☆` with review count
- Update timestamp (Minsk, UTC+3)

### Example message

What the message looks like in the chat (HTML is rendered by Telegram, so no tags are visible):

```
🔌 Chrome Web Store Statistics
━━━━━━━━━━━━━━━━━

📊 Summary
├ Extensions: 2
└ Total users: 1.2M

📈 Extensions

1. My Awesome Extension
├ 👥 Users: 1.1M
├ ⭐ ★★★★★ (2341)

2. Another Extension
├ 👥 Users: 89.3K
├ ⭐ ★★★★☆ (456)

━━━━━━━━━━━━━━━━━
⏰ Updated: 05.08.2026, 14:30 MSK
```

> In the chat the headers ("Chrome Web Store Statistics", "Summary", "Extensions") and the user counts appear in **bold**, and the extension names are **clickable links**. Under the hood the message is sent with `parse_mode: HTML`, so the raw text contains `<b>...</b>` and `<a href="...">...</a>` tags — these are rendered by Telegram and never shown as-is.

### Response

- Success: `200` with `{ success: true, stats: [...] }`
- Validation error: `400` if the token, chat ID, or extension list is missing
- Execution error: `500`

---

## 2. NPM Statistics — `npm-statistics.js`

Finds all npm packages belonging to a user by maintainer name and collects download statistics: total (since 2015-01-01), last week, and last month. Packages are sorted by total downloads.

### Parameters

| Parameter | Environment variable | Required | Description |
|-----------|----------------------|:--------:|-------------|
| `TELEGRAM_BOT_TOKEN` | `TELEGRAM_BOT_TOKEN` | ✅ | Telegram bot token |
| `TELEGRAM_CHAT_ID` | `TELEGRAM_CHAT_ID` | ✅ | Chat ID to send the report to |
| `NPM_USERNAME` | `NPM_USERNAME` | ⚠️ | npm username (maintainer). If empty, the package list will be empty |

### Example invocation

```json
{
  "TELEGRAM_BOT_TOKEN": "123456:ABC-DEF...",
  "TELEGRAM_CHAT_ID": "-1001234567890",
  "NPM_USERNAME": "my-npm-username"
}
```

### Data source

- Package search: `https://registry.npmjs.org/-/v1/search?text=maintainer:<username>&size=250` (up to 250 packages)
- Downloads for a period: `https://api.npmjs.org/downloads/point/<start>:<end>/<package>`
  - Total: from `2015-01-01` to today
  - Week: last 7 days
  - Month: last 30 days

### Report format (Telegram HTML)

- Header `📦 NPM Packages Statistics`
- Summary: number of packages, total and weekly download counts
- Per package: name (link to npm), total / weekly / monthly downloads, current version `vX.Y.Z`
- Update timestamp (Minsk, UTC+3)

### Example message

What the message looks like in the chat (HTML is rendered by Telegram, so no tags are visible):

```
📦 NPM Packages Statistics
━━━━━━━━━━━━━━━━━

📊 Summary
├ Packages: 3
├ Total downloads: 2.4M
└ Weekly downloads: 38.2K

📈 Packages

1. awesome-lib
├ 📥 Total: 1.5M
├ 📅 Week: 22.1K
├ 📅 Month: 95.3K
└ 📦 v2.4.1

2. helper-utils
├ 📥 Total: 812.5K
├ 📅 Week: 14.8K
├ 📅 Month: 61.2K
└ 📦 v0.9.3

━━━━━━━━━━━━━━━━━
⏰ Updated: 05.08.2026, 14:30 MSK
```

> In the chat the headers ("NPM Packages Statistics", "Summary", "Packages") and the "Total" download counts appear in **bold**, and the package names are **clickable links** to npm. Under the hood the message is sent with `parse_mode: HTML`, so the raw text contains `<b>...</b>` and `<a href="...">...</a>` tags — these are rendered by Telegram and never shown as-is.

### Response

- Success: `200` with `{ success: true, stats: [...] }`
- Validation error: `400` if the token or chat ID is missing
- Execution error: `500`

---

## 3. Zepp Apps Statistics — `zepp-statistics.js`

Authenticates against a Zepp (Huami) account and collects statistics for smartwatch apps over the last 180 days: download count, publish date, price (free/paid), and number of countries. Apps are sorted by download count.

### Parameters

| Parameter | Environment variable | Required | Description |
|-----------|----------------------|:--------:|-------------|
| `TELEGRAM_BOT_TOKEN` | `TELEGRAM_BOT_TOKEN` | ✅ | Telegram bot token |
| `TELEGRAM_CHAT_ID` | `TELEGRAM_CHAT_ID` | ✅ | Chat ID to send the report to |
| `ZEPP_EMAIL` | `ZEPP_EMAIL` | ⚠️ | Zepp account email |
| `ZEPP_PASSWORD` | `ZEPP_PASSWORD` | ⚠️ | Zepp account password |
| `USER_ID` | `USER_ID` | ⚠️ | Zepp user ID |

### Authentication flow

1. `getAuthorizationCode(email, password)` — requests `api-user.huami.com` to obtain an authorization code.
2. `getAccessToken(authCode)` — exchanges the code for an `app_token` via `account.huami.com/v2/client/login`.
3. `getStatistics(appToken, userId, start, end)` — requests statistics for the period (default 180 days) from `api-mifit-cn3.zepp.com/market/open/statistics`.

### Report format (Telegram MarkdownV2)

- Header `⌚️ Zepp Apps Statistics` and the period (dates in `DD.MM.YYYY` format)
- Summary: total number of apps and total download count
- Per app: name, downloads, publish date, `🆓 Free` / `💰 Paid` status, number of countries
- Update timestamp (Minsk, UTC+3)
- Markdown special characters are escaped (`escapeMarkdown`)

### Example message

What the message looks like in the chat (MarkdownV2 is rendered by Telegram, so the escape backslashes are invisible):

```
⌚️ Zepp Apps Statistics
📅 05.08.2025 - 05.08.2026
━━━━━━━━━━━━━━━━━

📊 Summary
├ Total apps: 5
└ Total downloads: 12.5K

📈 Apps Performance

1. Step Counter Pro
├ 📥 Downloads: 8.2K
├ 📅 Published: 12.03.2026
├ 🆓 Free
└ 🌍 12 countries

2. Heart Rate Monitor
├ 📥 Downloads: 3.1K
├ 📅 Published: 27.01.2026
├ 💰 Paid
└ 🌍 8 countries

━━━━━━━━━━━━━━━━━
⏰ Updated: 05.08.2026, 14:30 MSK
```

> In the chat the header, "Summary", "Apps Performance", the app names and the download counts appear in **bold**. Under the hood the message is sent with `parse_mode: MarkdownV2`, so special characters such as `.`, `-` and `*` are escaped with backslashes (e.g. `05\.08\.2026`) and `*text*` marks bold — Telegram strips the backslashes and renders the formatting, so they are never shown in the chat.

### Sending notes

- Primary format is `MarkdownV2`. If rendering fails, the message is automatically re-sent as plain text (`sendTelegramMessageSimple`) with all formatting characters stripped.

### Response

- Success: `200` with `{ success: true }`
- Validation error: `400` if the token or chat ID is missing
- Execution error: `500`

---

## Deployment (DigitalOcean Functions)

The functions are meant to run in DigitalOcean Functions. Each function:

- Exports `main(args)` as the entry point.
- Accepts parameters through the `args` object (JSON on invocation).
- Falls back to function environment variables when `args` is not provided.

### Secrets recommendation

Sensitive parameters (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, passwords) are better stored in function environment variables or in DigitalOcean's protected secrets storage rather than in the request body.

### Scheduled runs

The functions are designed for periodic invocation (e.g., once a day) via the DigitalOcean Functions Scheduler or an external cron job so that fresh reports are sent to Telegram regularly.

---

## Setting up the Telegram bot

### 1. Create a bot

1. Open Telegram and start a chat with **@BotFather**.
2. Send the command:
   ```
   /newbot
   ```
3. Follow the prompts: choose a display name and a username for the bot (must end in `bot`).
4. After creation, BotFather replies with an **HTTP API token** that looks like:
   ```
   1234567890:AAHf...some-long-token
   ```
   Copy this token — it is your `TELEGRAM_BOT_TOKEN`.

> ⚠️ Keep the token secret. Anyone who has it can control your bot. If it leaks, use `/revoke` in BotFather and generate a new one.

### 2. Get the chat ID

The bot can only send messages to chats it knows about. Choose one of these options:

**Option A — direct chat with the bot (simplest)**
1. Start a chat with your bot and press **Start**.
2. Get your user chat ID via one of these methods:
   - Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser — the `chat.id` of the message from you will be in the JSON response. It's a positive number like `123456789`.
   - Or message the bot **@userinfobot** and it will reply with your ID.

**Option B — group chat**
1. Add your bot to a Telegram group.
2. Send a message in the group (or run the function once).
3. Read `chat.id` from the `/getUpdates` response. Group IDs are negative numbers like `-1001234567890` (supergroups).

### 3. Test the connection

You can verify the token is valid with:

```
https://api.telegram.org/bot<YOUR_TOKEN>/getMe
```

A successful response looks like:

```json
{"ok":true,"result":{"id":1234567890,"is_bot":true,"first_name":"...","username":"..._bot"}}
```

### 4. Use the values in the functions

Pass the token and chat ID as `args` or environment variables:

```json
{
  "TELEGRAM_BOT_TOKEN": "1234567890:AAHf...",
  "TELEGRAM_CHAT_ID": "-1001234567890"
}
```

### 5. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `400: chat not found` | Wrong chat ID, or the bot has never seen this chat | Send `/start` (or a message in the group) first, then re-read `getUpdates` |
| `401: Unauthorized` | Invalid bot token | Re-copy the token from BotFather |
| Bot ignores messages | Bot was added to a group without admin rights or privacy mode blocks it | Not required for sending — sending is always allowed; only reading requires admin |
| Message sent as plain text | `MarkdownV2`/`HTML` parse error | The function already falls back to plain text automatically |

---

## Utility functions

All three files share common helper functions:

| Function | File(s) | Description |
|----------|---------|-------------|
| `formatNumber(num)` | all | Number shortening: `1.5M`, `2.3K` |
| `getMinskTime()` | npm, zepp | Current Minsk time (UTC+3) |
| `formatDate(date)` | zepp | Date as `YYYY-MM-DD` (for the API) |
| `formatMinskDateDisplay(date)` | zepp | Date as `DD.MM.YYYY` in Minsk time |
| `escapeMarkdown(text)` | zepp | Escapes MarkdownV2 special characters |
| `sendTelegramMessage(...)` | all | Sends a message to Telegram |
| `sendTelegramMessageSimple(...)` | npm, zepp | Sends plain text (fallback) |
