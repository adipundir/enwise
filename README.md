# envoice

An MCP server for running an invoicing business entirely through natural language in Claude. Built on Next.js + Neon Postgres + Vercel.

## What it does

- **MCP server** at `/api/mcp`. Claude calls tools to create invoices, manage clients, send emails, and more.
- **Public invoice page** at `/i/[slug]`. shareable link for recipients with a downloadable PDF.
- **Web dashboard** at `/dashboard`. exists for sign-in, API token generation, and a quick overview of what Claude has done. Everything else happens in Claude.

40 MCP tools shipped: `whoami`, business profile (2), clients (6), products (6), invoices (14), analytics (3), recurring (7), `send_invoice`. Share links, PDFs, and emails are automatic.

## Local development

### 1. Prerequisites

- **Node.js**. `~/.local/share/node` (v24.15.0 LTS) with `node`/`npm`/`npx` symlinked into `~/.local/bin`.
- **Neon Postgres**. free tier. [console.neon.tech](https://console.neon.tech). Use the pooled connection string.
- **At least one OAuth provider**:
  - **GitHub**. [Developer Settings → OAuth Apps](https://github.com/settings/developers). Callback: `http://localhost:3000/api/auth/callback/github`.
  - **Google**. [Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials). Redirect: `http://localhost:3000/api/auth/callback/google`. Authorized origin: `http://localhost:3000`.

### 2. Environment

Required in `.env`:

```
DATABASE_URL=postgres://...         # Neon pooled
AUTH_SECRET=...                     # openssl rand -base64 32
AUTH_URL=http://localhost:3000
CRON_SECRET=...                     # openssl rand -hex 32

# Plus at least one OAuth provider:
AUTH_GITHUB_ID=...
AUTH_GITHUB_SECRET=...
AUTH_GOOGLE_ID=...
AUTH_GOOGLE_SECRET=...

# Optional. features degrade gracefully if absent:
RESEND_API_KEY=...                  # email sending
BLOB_READ_WRITE_TOKEN=...           # logo uploads (else URLs stored verbatim)
PUBLIC_BASE_URL=http://localhost:3000
```

### 3. Database

```bash
npm run db:migrate     # applies migrations + enables pg_trgm/unaccent + creates trigram indexes
```

`db:migrate` is idempotent.

### 4. Run

```bash
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000).

### 5. Verify the MCP endpoint

```bash
npm run smoke:mcp
```

Spins up a throwaway user/business/token, hits every tool through `/api/mcp`, verifies PDF generation, then cleans up.

## Deploying to Vercel

### 1. Push to GitHub

Already done (`origin/main`).

### 2. Import into Vercel

[Vercel → New Project → import from Git](https://vercel.com/new). Framework auto-detected as Next.js.

### 3. Attach storage

In the project dashboard → Storage:
- **Neon**. connect your existing Neon project. `DATABASE_URL` lands in env vars automatically.
- **Blob**. create a store. `BLOB_READ_WRITE_TOKEN` lands in env vars automatically.

### 4. Add env vars

Project → Settings → Environment Variables (Production + Preview + Development):

| Variable | Where from |
|---|---|
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `AUTH_URL` | `https://<your-vercel-domain>` (e.g. `envoice.vercel.app`) |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | GitHub OAuth app (create a separate app or add the prod callback to the existing one) |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google OAuth client (add prod callback + origin) |
| `CRON_SECRET` | `openssl rand -hex 32` |
| `PUBLIC_BASE_URL` | `https://<your-vercel-domain>` |
| `RESEND_API_KEY` | [resend.com/api-keys](https://resend.com/api-keys). Verify a domain first or Resend will reject sends. |
| `RESEND_FROM_ADDRESS` | Must live on a verified Resend domain, e.g. `invoices@envoice.app` |

### 5. Update OAuth callback URLs

- **GitHub**: add `https://<your-vercel-domain>/api/auth/callback/github` as Authorization callback URL. (GitHub allows only one per app. create a second OAuth app for prod or edit on deploy.)
- **Google**: add `https://<your-vercel-domain>/api/auth/callback/google` as an Authorized redirect URI. Also add `https://<your-vercel-domain>` as an Authorized JavaScript origin.

### 6. Run migrations against prod

Locally, with `DATABASE_URL` pointed at the prod branch (or via Neon CLI/UI):

```bash
DATABASE_URL="postgres://…prod…" npm run db:migrate
```

### 7. Cron

`vercel.json` schedules `/api/cron/recurring` daily at 09:00 UTC. Vercel Cron is enabled automatically for Pro plans and above on deploy.

### 8. Health check

`GET /api/health` returns `{ ok, db_ok, latency_ms, version, timestamp }`. Use it for uptime monitors.

## Project layout

```
app/                  # Next.js App Router
├─ page.tsx           # public landing
├─ signin/            # custom Auth.js sign-in page
├─ dashboard/         # auth-gated web UI (API tokens + connection instructions + overview)
├─ api/auth/          # Auth.js handlers
├─ api/mcp/           # MCP server endpoint
├─ api/cron/recurring # daily recurring-invoice cron
├─ api/health/        # uptime probe
└─ i/[slug]/          # public invoice page + PDF

lib/
├─ db/                # Drizzle schema + client + migrations
├─ mcp/               # MCP server + per-entity tool handlers
├─ pdf/               # React-PDF rendering
├─ email/             # Resend wrappers
├─ storage/           # Vercel Blob helpers + SSRF guard
├─ analytics.ts       # client/revenue/outstanding aggregates
├─ recurring.ts       # recurring-invoice service + runner
├─ ratelimit.ts       # DB-backed per-token rate limiter
├─ idempotency.ts     # withIdempotency() wrapper
└─ *.ts               # service layer per entity

auth.ts               # Auth.js v5 config (Google + GitHub + Drizzle adapter + DB sessions)
drizzle.config.ts     # Drizzle Kit config
vercel.json           # cron schedule
```

## Phase status

- [x] **Phase 0**. scaffold, DB, Auth.js Google+GitHub sign-in, gated dashboard
- [x] **Phase 1**. API tokens + MCP endpoint + bearer auth + `whoami`
- [x] **Phase 2**. business profile + logo upload (URL/base64, SSRF-guarded)
- [x] **Phase 3**. clients + products + fuzzy find (pg_trgm)
- [x] **Phase 4**. invoices, atomic numbering, public share, PDF rendering
- [x] **Phase 5**. `send_invoice` via Resend with PDF attachment
- [x] **Phase 6**. analytics (client summary, revenue, outstanding)
- [x] **Phase 7**. recurring invoices + Vercel cron
- [x] **Phase 8 (audit pass)**. SSRF guard, per-token rate limit, send idempotency, paid badge, dashboard overview, `/api/health`
