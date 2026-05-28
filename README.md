# depot-bot

Telegram bot + Telegram WebApp for UAF depot (~100 daily users).
Built on Cloudflare Workers + D1 + React. Completely Free tier for all.

Three core features today:

1. **Off Tracker** — credit-based off-day system. Users (or admins on their behalf) propose off credits → superior approves → credits become spendable on actual off requests (start/end dates), with another superior approval step.
2. **Report Sick (RSI / RSO)** — user reports → superior approves → structured MC update (days + dates + medicine) → escalation reminder if not updated in time.
3. **Parade State** — per-user, per-day, per-period (AM + PM) status calendar with admin/superadmin CSV export. Auto-nudges 9pm prev day / 5:30am / 12:00 noon SGT on working days only.

Two helper features:

- **Public-holiday awareness** for the reminders, sourced from nager.date with a confirm-before-trust workflow and superadmin overrides.
- **ORD reminders** to superadmins at T-30 and T-0 days, with a Delete User button on the day-of message.

---

## Architecture (mental model)

One Cloudflare Worker is the whole backend:

| URL pattern | What it does |
|---|---|
| `POST /webhook` | Receives Telegram updates (auth via `X-Telegram-Bot-Api-Secret-Token` header) |
| `/api/*` | JSON endpoints for the WebApp (auth via Telegram WebApp `initData` HMAC) |
| anything else | Static React build served via the Workers Assets binding (`frontend/dist/`) |

One D1 database (`depot_db`) is the only persistent store.

Cron triggers (in `wrangler.jsonc`):

| Cron (UTC) | SGT | Action |
|---|---|---|
| `*/5 * * * *` | every 5 min | drain `reminders` queue (sick 3h/6h/8h follow-ups) |
| `0 13 * * *` | 21:00 prev day | nudge users with no AM entry for tomorrow (working days only) |
| `30 21 * * *` | 05:30 same day | general parade-state nudge (reassures if already filled) |
| `0 4 * * *` | 12:00 same day | PM parade-state nudge + daily nager.date holiday refresh |
| `0 0 * * *` | 08:00 same day | ORD scan + parade-state pruning (> 5 days old) |

---

## Role functionality matrix

There are three roles: **`user`**, **`admin`**, **`superadmin`**. The first user registered becomes `user` by default; promotions are done by an existing admin/superadmin.

### user

| Tab | What they can do |
|---|---|
| 🪖 Parade | Submit/edit own AM and/or PM parade status for any date range (default today, single day; range optional). View the month calendar with their own AM/PM chips. View everyone's submitted entries for the selected day. |
| 📅 Off | See their own off-credit balance. Request an off (start/end + reason). Cancel their own pending off requests. **Credit Off(s)** — propose extra credits for themselves (requires their superior's approval). View everyone's approved-off count + per-user detail. |
| 🤒 Sick | Report sick (RSI in-camp / RSO outside). Cancel a pending sick report. Once approved, fill the structured MC form (number of days; if ≥1, MC start + end dates; optional medicine). |

### admin (everything `user` can do, plus)

| Tab | Extras |
|---|---|
| 📊 Today | Visible. Shows: who's on approved off today, all open sick cases, pending off approvals, pending sick approvals. |
| 📅 Off | **Credit Off(s)** modal now offers a "Recipient" dropdown to credit one of their direct reports (still requires that staff's superior to approve). Can **↩ Revert** approvals they previously gave (credits refund automatically). |
| ⚙ Admin | Visible. **Users**: edit name / department / STG sub-department / superior / ORD date / personnel type (NSF, NSF Officer, or Regular) for any user. **Overrides**: read-only view of working-day overrides. **Holidays**: read-only view of confirmed/pending public holidays. |
| (Telegram DMs) | Receives approval DMs with inline `[Approve] / [Reject]` buttons for: off requests from direct reports, off-credit grant proposals where they are the recipient's superior, sick reports from direct reports. |

Restriction: admins cannot grant the `superadmin` role; cannot delete users; cannot revert someone else's approval (only their own).

### superadmin (everything `admin` can do, plus)

| Tab | Extras |
|---|---|
| 📅 Off | Recipient dropdown shows every active user (not just direct reports). Can revert **any** approval, not just their own. |
| ⚙ Admin → Users | Can promote to `superadmin`. Can **🗑 Delete user** (irreversible). |
| ⚙ Admin → Overrides | Can `+ Add override` (force a date to working or non-working) and remove existing overrides. |
| ⚙ Admin → Holidays | Can **🔄 Force refresh now** (re-fetches nager.date and stages a confirm flow), **✅ Confirm / ❌ Reject** pending holiday changes, **+ Add holiday** manually (e.g. ad-hoc Polling Day), and **Remove** confirmed holidays. |
| 🪖 Parade | **Export CSV** for a single date (grouped by department) — file is delivered into your Telegram chat with the bot. |
| (Telegram DMs) | Receives **ORD reminders** at T-30 days and on-the-day (the day-of message includes a 🗑 Delete user button). Receives **public-holiday change** notifications from the daily nager.date diff, with `[Confirm] / [Reject] / [Treat as working day]` inline buttons. |

---

## Editing details — admin/superadmin walkthrough

### Edit a user's profile (department, role, ORD, personnel type, etc.)

1. Open the WebApp → tap **⚙ Admin** (admins/superadmins only) → **👥 Users** sub-tab.
2. Users are grouped by department (DHQ, DMSP, DCS, STG — C1+C2, STG — C3+C4, Others, Unassigned). Pending users (those who only sent `/start` but haven't been set up) appear at the top.
3. Tap a user row → the **Edit user** modal opens with these fields:
   - **Full name** — what shows everywhere
   - **Personnel type** — `NSF` or `Regular` (renders as a small badge on the user row)
   - **Department** — DHQ / DMSP / DCS / STG / Others
   - **STG sub-department** — only appears when Department = STG. Choose `C1+C2` or `C3+C4`
   - **Role** — `user` / `admin` / `superadmin` (superadmin option only shown if you are one)
   - **Superior's Telegram ID** — the numeric ID of who approves this user's off / sick / credit-grant requests
   - **ORD date** — used by the 08:00 SGT cron to DM all superadmins at T-30 and T-0 days
4. **Save** persists the edit and updates the screen immediately.
5. **🗑 Delete user** (superadmin only, not visible for your own row) — confirms first, hard-deletes the user. Their historical rows in off_requests / sick_cases / parade_state_entries are orphaned (left in place, queries LEFT JOIN so they show as "?").

### Add a public holiday manually

When nager.date is unavailable or MOM declares an ad-hoc holiday (e.g. Polling Day):

1. **⚙ Admin → 🇸🇬 Holidays** → **+ Add holiday**.
2. Enter the date and a name. Submitted holidays are confirmed immediately.

### Force-refresh holidays

Daily at 12:00 SGT the worker auto-fetches from nager.date and DMs superadmins for confirm-before-trust. You can also do it on demand:

1. **⚙ Admin → 🇸🇬 Holidays** → **🔄 Force refresh now**.
2. The response message tells you what happened:
   - "Bootstrap complete — cached N holidays" (first ever fetch; auto-confirmed)
   - "Already up to date" (no changes from nager.date)
   - "N change(s) detected — check DM" (new/changed/removed dates staged for confirm; check the Telegram DM from your own bot)

### Force a date to be working / non-working

Use this for weekend exercises, makeup days, or when MOM's holiday designation doesn't match your unit's operating reality.

1. **⚙ Admin → 📆 Overrides** → **+ Add override**.
2. Pick a date. The toggle defaults intelligently — Saturday/Sunday default to "Force working", weekdays default to "Force non-working".
3. Optionally enter a reason. Save.

Override precedence: `working_day_overrides` > `public_holidays` > weekend rule.

### Revert an off approval

1. Open **📅 Off** → tap a user → find the approved off in the table.
2. Tap **↩ Revert** in the action column (visible to the original approver, or to any superadmin).
3. Confirm. The approval flips to `reverted`, off credits are refunded automatically, and both the requester and the original approver get a DM.

### Cancel your own pending off request

1. Open **📅 Off** → scroll to "My recent requests".
2. On any `pending` row, tap **🗑 Cancel**. Your superior gets a DM that you cancelled.

### Export parade state for one date (admin/superadmin)

1. **🪖 Parade** → scroll to "Export CSV".
2. Pick the date (defaults to the day you currently have selected on the calendar).
3. Tap **📤 Send CSV**. The bot DMs the CSV file to your chat (Telegram WebView blocks direct downloads, so we deliver it as a Telegram document instead).

CSV columns: `department, name, period, status, reason`.

### Editing details directly in the database (advanced)

Most edits should go through the WebApp. For one-off corrections or bulk changes, you can hit D1 directly:

```bash
# Promote yourself to superadmin
npx wrangler d1 execute depot_db --remote --command \
  "UPDATE users SET user_role='superadmin' WHERE telegram_id='<YOUR_TG_ID>'"

# Adjust someone's off-credit balance
npx wrangler d1 execute depot_db --remote --command \
  "UPDATE users SET off_credits = 5 WHERE id = 12"

# Wipe a user's stale parade entries
npx wrangler d1 execute depot_db --remote --command \
  "DELETE FROM parade_state_entries WHERE user_id = 12 AND parade_state_date < date('now','-7 days')"
```

---

## Setting up the coding environment on a new computer (VS Code)

Step-by-step from a fresh laptop. Macs, Linux, and Windows (WSL) all work; commands shown are POSIX shell.

### 1. Install prerequisites

| Tool | What you need | Install |
|---|---|---|
| Node.js | v22+ (LTS) | https://nodejs.org or `nvm install 22` |
| Git | any recent | `apt install git` / `brew install git` / https://git-scm.com |
| VS Code | latest | https://code.visualstudio.com |
| (optional) cloudflared | for tunnelling localhost during dev | `brew install cloudflared` / https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads |

Verify:
```bash
node -v   # should print v22.x
npm -v
git --version
```

### 2. Clone the repo

```bash
git clone <your-git-remote-url> depot-bot
cd depot-bot
```

### 3. Install dependencies

```bash
# Root (worker)
npm install

# Frontend (React + Vite)
cd frontend
npm install
cd ..
```

### 4. Recommended VS Code extensions

Open the repo folder in VS Code (`code .`). Install:

- **Cloudflare Workers** (`cloudflare.cloudflare-workers`) — Wrangler integration, log streaming
- **ESLint** (`dbaeumer.vscode-eslint`) — frontend lint
- **TypeScript Vue Plugin / Volar**? — not needed; TypeScript is built into VS Code
- **Prettier** (`esbenp.prettier-vscode`) — matches the `.prettierrc` (140 cols, tabs, single quotes)
- **SQLite Viewer** (`qwtel.sqlite-viewer`) — to inspect `.wrangler/state/d1/...` local DB
- **EditorConfig** (`editorconfig.editorconfig`) — consistency

Suggested user settings (auto-applied if you use the workspace's `.vscode/settings.json` once you create one):

```jsonc
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "[typescript]":        { "editor.defaultFormatter": "esbenp.prettier-vscode" },
  "[typescriptreact]":   { "editor.defaultFormatter": "esbenp.prettier-vscode" },
  "typescript.tsdk":     "node_modules/typescript/lib"
}
```

### 5. Get a Cloudflare account + log in to Wrangler

If you don't have a Cloudflare account: sign up at https://dash.cloudflare.com/sign-up (free).

```bash
npx wrangler login    # opens a browser → authorize → close
```

### 6. Provision / link the D1 database

If `wrangler.jsonc` already lists a `database_id`, the database exists in your Cloudflare account already — skip to step 7.

If you're standing up a brand-new environment:
```bash
npx wrangler d1 create depot_db
# Copy the printed `database_id` into wrangler.jsonc under d1_databases[0].database_id
```

### 7. Create a Telegram bot

DM **@BotFather** in Telegram:
- `/newbot` → choose a display name and a unique username ending in `bot` (e.g. `mydepot_dev_bot`)
- Copy the bot token it returns (looks like `1234567890:AA…`)

For development you should create a **second** bot (e.g. `mydepot_dev_bot`) so production stays untouched while you `wrangler dev`. Webhooks can only point to one URL per bot.

### 8. Set local + production secrets

```bash
# Local dev — wrangler dev reads .dev.vars automatically
cp .dev.vars.example .dev.vars
# Open .dev.vars in VS Code and fill:
#   BOT_TOKEN=1234567890:AA…
#   WEBHOOK_SECRET=<run `openssl rand -hex 32` for a fresh random string>

# Production — pushes to Cloudflare's encrypted secret store
npx wrangler secret put BOT_TOKEN          # paste prod bot token
npx wrangler secret put WEBHOOK_SECRET     # paste a (separate) random 32+ char string
```

### 9. Apply database migrations (in order)

```bash
# Local D1 (so `wrangler dev` works) — apply each migration in numeric order
for f in worker/src/db/migrations/*.sql; do
  npx wrangler d1 execute depot_db --local --file "$f"
done

# Production D1
for f in worker/src/db/migrations/*.sql; do
  npx wrangler d1 execute depot_db --remote --file "$f"
done
```

(Or apply them one at a time so you can spot errors.)

### 10. Seed yourself as superadmin

Get your numeric Telegram ID by DMing `@userinfobot`. Then:

```bash
npx wrangler d1 execute depot_db --remote --command \
  "INSERT INTO users (telegram_id, full_name, user_role) VALUES ('<YOUR_TG_ID>', 'Your Name', 'superadmin')"
```

### 11. Build and deploy

```bash
npm run build:frontend    # vite build → frontend/dist
npx wrangler deploy       # publishes the worker (frontend/dist is uploaded via assets binding)
```

After the first deploy, Wrangler prints your URL (e.g. `https://depot-bot.<your-subdomain>.workers.dev`). Update `WEBAPP_URL` in `wrangler.jsonc` to that exact URL, then redeploy:

```bash
npm run deploy            # runs predeploy (build:frontend) + wrangler deploy
```

### 12. Register the webhook with Telegram

```bash
# Load the values you set in .dev.vars into your shell
set -a && source .dev.vars && set +a
PUBLIC_URL="https://depot-bot.<your-subdomain>.workers.dev"

curl "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=${PUBLIC_URL}/webhook" \
  -d "secret_token=${WEBHOOK_SECRET}" \
  -d 'allowed_updates=["message","callback_query"]'
```

Should return `{"ok":true,...}`. Verify:
```bash
curl "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

### 13. Configure the WebApp in @BotFather

In Telegram, DM `@BotFather`:

```
/setdomain
→ pick your bot
→ enter:  depot-bot.<your-subdomain>.workers.dev   (no protocol, no path)

/setmenubutton
→ pick your bot
→ Button text: Open Depot App
→ URL: https://depot-bot.<your-subdomain>.workers.dev

/newapp           # gives you the blue "Open" button on the bot's profile
→ pick your bot
→ Title: Depot
→ Description: UAF depot management
→ Photo: upload a 640×360 PNG (or send /empty)
→ GIF: /empty
→ Web App URL: https://depot-bot.<your-subdomain>.workers.dev
→ Short name: app    (becomes t.me/<botusername>/app)
```

### 14. Test the loop

1. In Telegram, search for your bot, tap **/start** — you should get a "pending account" message and a DB row appears (`SELECT * FROM users`).
2. Bootstrap that row to `superadmin` (step 10, but use the telegram_id of your test account).
3. Send any message in the chat → tap the menu icon at the bottom-left of the chat input. The WebApp should open with all five tabs (Parade / Off / Sick / Today / Admin).

---

## Local development loop

```bash
# Terminal 1 — worker
npx wrangler dev                 # http://localhost:8787

# Terminal 2 — expose to Telegram via HTTPS
cloudflared tunnel --url http://localhost:8787    # prints https://<random>.trycloudflare.com

# Terminal 3 — point your DEV bot at the tunnel (do NOT do this with prod bot)
set -a && source .dev.vars && set +a
curl "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=https://<random>.trycloudflare.com/webhook" \
  -d "secret_token=${WEBHOOK_SECRET}" \
  -d 'allowed_updates=["message","callback_query"]'
```

Worker code changes hot-reload on file save. **Frontend changes** need a rebuild:

```bash
npm run build:frontend
# Then in Telegram: close the WebApp, force-quit Telegram, reopen. Telegram caches HTML.
```

To trigger a cron locally:

```bash
# URL-encode the cron string — '*/5 * * * *' becomes '*%2F5+*+*+*+*'
curl "http://localhost:8787/__scheduled?cron=*%2F5+*+*+*+*"
```

---

## Migrations history

Always apply in numeric order on both local and remote.

| File | What it added |
|---|---|
| `001_init.sql` | Initial schema: users, off_requests, sick_cases, parade_state_entries, reminders, indexes |
| `002_round2.sql` | Role rename (superior → admin, admin → superadmin), `ord_date`, parade AM/PM split, structured sick MC fields, public_holidays + working_day_overrides tables, cancel/revert audit columns |
| `003_off_credits_and_department.sql` | `users.department`, `users.off_credits`, `off_credit_grants` table |
| `004_personnel_type_subdept_status_remap.sql` | `users.personnel_type`, `users.sub_department`, remap legacy parade statuses (`Off → OFF`, `Leave → LL`, `Overseas Leave → OL`, `Attached-Out → AO`) |
| `005_rename_dsp_to_stg.sql` | Rename `users.department` value `DSP → STG` (the section was always called STG in the report; the dept enum now matches) |
| `006_indexes.sql` | Add missing read-path indexes: `idx_sick_user_status`, `idx_sick_status`, `idx_off_status_enddate`, `idx_reminders_related`, partial `idx_users_ord_date`. Pure CREATE INDEX IF NOT EXISTS — safe to re-run. |

When you write a migration:
- Use `PRAGMA foreign_keys = OFF;` at the top if you're rebuilding any table that has FK references pointing in.
- Use `INSERT … SELECT` with `CASE` transformations rather than staged `UPDATE temp_x` (the latter can violate the old CHECK constraint and roll back the whole migration).
- Use `ALTER TABLE … ADD COLUMN` for additive changes (no rebuild needed).

---

## Operations cheatsheet

| Task | Command |
|---|---|
| Tail prod logs | `npx wrangler tail` |
| Inspect remote D1 | `npx wrangler d1 execute depot_db --remote --command "SELECT id, full_name, user_role, off_credits FROM users"` |
| Re-apply latest migration | `npx wrangler d1 execute depot_db --remote --file worker/src/db/migrations/<file>.sql` |
| Rotate webhook secret | `npx wrangler secret put WEBHOOK_SECRET`, then re-run the `setWebhook` curl with the new value |
| Disable webhook (kill switch) | `curl "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook"` |
| Re-generate Workers types after `wrangler.jsonc` change | `npx wrangler types` |
| Wipe local D1 and start over | `rm -rf .wrangler/state/v3/d1` then re-apply migrations with `--local` |
| Type-check worker | `npx tsc --noEmit` |
| Type-check frontend | `cd frontend && npx tsc -b` |

---

## Free-tier accounting (does this stay free for 90 users?)

| Resource | Free limit | Expected usage | Headroom |
|---|---|---|---|
| Workers requests | 100,000 / day | ~5,000 / day | 20× |
| D1 reads | 5,000,000 / day | ~30,000 / day | 150× |
| D1 writes | 100,000 / day | ~2,000 / day | 50× |
| D1 storage | 5 GB | < 50 MB after years (parade entries auto-prune after 5 days) | trivial |
| Cron triggers | unlimited (counted in 100k requests) | ~290 / day | trivial |
| Workers Assets | unlimited | static React build (~100 KB gzip) | — |
| Outbound fetch (nager.date, Telegram API) | unmetered | trivial | — |

Conclusion: comfortably free.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| WebApp shows blank screen | `frontend/dist` not deployed, or asset bundle 404 | `npm run build:frontend && npx wrangler deploy`, then force-quit Telegram |
| `⚠ HTTP 401 — missing_init_data` | Opened the URL outside Telegram, or via wrong menu button | Open via BotFather menu button only |
| `⚠ HTTP 401 — invalid_init_data` | Prod `BOT_TOKEN` secret doesn't match the bot you're testing with | `npx wrangler secret put BOT_TOKEN` with the correct token |
| `⚠ HTTP 403 — not_registered` | `/start` hasn't been sent yet for this Telegram account | DM the bot `/start` once |
| "Force refresh" did nothing | API fetched 0 records (nager.date hiccup) | Try again later, or **+ Add holiday** manually |
| Buttons (Cancel / Revert / Delete) do nothing | Telegram's `showConfirm` is unreliable on some clients — we already wrap with `confirmDialog()` that falls back to `window.confirm` after 2s |
| Bot doesn't reply to `/start` | Webhook isn't set, secret mismatch, or token invalid | `curl ".../getWebhookInfo"`, check `url` and `last_error_message` fields |
| Migration fails with FOREIGN KEY constraint | Old FK references blocking rebuild | Migrations already issue `PRAGMA foreign_keys = OFF;` — make sure the migration file you're re-applying has that line |

---

## Security notes (don't skip)

- **`BOT_TOKEN` and `WEBHOOK_SECRET` must never be committed** to git. `.dev.vars` is gitignored; `wrangler secret` stores them encrypted on Cloudflare's side. If a token ever leaks, immediately `@BotFather → /revoke` and push the new one with `npx wrangler secret put BOT_TOKEN`.
- Every `/api/*` request validates the Telegram `initData` HMAC — never trust a `telegram_id` from the client.
- Don't store personal data (NRIC, IC numbers) in this DB — `telegram_id` + `full_name` is sufficient.
- The webhook endpoint rejects any POST whose `X-Telegram-Bot-Api-Secret-Token` header doesn't match `env.WEBHOOK_SECRET`.

## Future feature (deliberately deferred)

**Training attendance** — reuses the same patterns: a `training_sessions` table, an `attendance` table, the existing `reminders` table with `related_type='training_session'`. No architecture change needed when it's added.
