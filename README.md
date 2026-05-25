# depot-bot

Telegram bot + WebApp for a UAF depot (~90 users). Cloudflare Workers + D1 + React. Free tier.

## Architecture

One Worker, three jobs:
- `POST /webhook` — Telegram updates (verified via `X-Telegram-Bot-Api-Secret-Token`).
- `/api/*` — JSON endpoints for the WebApp (verified via Telegram `initData` HMAC).
- everything else → static React build served via the `ASSETS` binding.

Persistence: a single D1 database (`depot_db`). Scheduling: 4 cron triggers — one to drain `reminders` every 5 min, three daily nudges for parade state.

## First-time setup

### 1. Bot token & webhook secret

```bash
# Push secrets (only once — they're stored encrypted by Cloudflare)
npx wrangler secret put BOT_TOKEN          # paste BotFather token
npx wrangler secret put WEBHOOK_SECRET     # any random 32-char hex string

# For local dev, copy .dev.vars.example to .dev.vars and fill the same values
cp .dev.vars.example .dev.vars
```

### 2. Database migration

```bash
# Local D1 (for `wrangler dev`)
npx wrangler d1 execute depot_db --local  --file worker/src/db/migrations/001_init.sql

# Production D1
npx wrangler d1 execute depot_db --remote --file worker/src/db/migrations/001_init.sql
```

### 3. Seed yourself as admin

Get your Telegram numeric ID (DM `@userinfobot` to find it), then:

```bash
npx wrangler d1 execute depot_db --remote --command \
  "INSERT INTO users (telegram_id, full_name, user_role) VALUES ('<YOUR_TG_ID>', 'Your Name', 'admin');"
```

### 4. Build & deploy

```bash
npm run build:frontend   # builds frontend/dist
npx wrangler deploy
```

After the first deploy, Cloudflare prints your public URL (e.g. `https://depot-bot.<subdomain>.workers.dev`). Update `WEBAPP_URL` in `wrangler.jsonc`, then re-deploy:

```bash
npx wrangler deploy
```

### 5. Register the webhook with Telegram

```bash
BOT_TOKEN="<your bot token>"
WEBHOOK_SECRET="<the same secret you set above>"
PUBLIC_URL="https://depot-bot.<subdomain>.workers.dev"

curl "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=${PUBLIC_URL}/webhook" \
  -d "secret_token=${WEBHOOK_SECRET}" \
  -d 'allowed_updates=["message","callback_query"]'
```

### 6. Tell @BotFather about the WebApp

In Telegram, DM `@BotFather`:

```
/setdomain
→ pick your bot
→ enter:  depot-bot.<subdomain>.workers.dev

/setmenubutton
→ pick your bot
→ Button text: Open Depot App
→ URL: https://depot-bot.<subdomain>.workers.dev
```

## Local development

```bash
npx wrangler dev                             # starts the worker on :8787
# In another shell:
cloudflared tunnel --url http://localhost:8787   # exposes a public HTTPS URL
# Point a TEST bot's webhook at the tunnel URL while developing.
```

To trigger a cron locally:

```bash
# Use the exact cron string from wrangler.jsonc
curl "http://localhost:8787/__scheduled?cron=*%2F5+*+*+*+*"
```

## Operations cheatsheet

| Task | Command |
|---|---|
| Tail prod logs | `npx wrangler tail` |
| Inspect D1 | `npx wrangler d1 execute depot_db --remote --command 'SELECT * FROM users;'` |
| Rotate webhook secret | `wrangler secret put WEBHOOK_SECRET` then re-run setWebhook |
| Disable webhook | `curl "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook"` |
| Re-generate types after `wrangler.jsonc` change | `npx wrangler types` |
