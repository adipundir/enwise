# enwise

An MCP server for running an invoicing business entirely through natural language in Claude. Recipients pay hosted invoices in USDC from their own wallet. Built on Next.js + Neon Postgres + Vercel.

## What it does

- **MCP server** at `/api/mcp`. Claude calls tools to create invoices, manage clients, send emails, and more.
- **Public invoice page** at `/i/[slug]`. shareable link for recipients with a downloadable PDF.
- **Web dashboard** at `/dashboard`. exists for sign-in, API token generation, and a quick overview of what Claude has done. Everything else happens in Claude.
- **Attachment uploads** via presigned PUT. Claude calls `request_attachment_upload`, gets a 30-min scoped URL, PUTs bytes directly to Vercel Blob. The user's API token never leaves the MCP server, bytes never traverse our function.
- **Wallet payments.** The hosted invoice page renders a Pay-with-USDC button (`PayWithWalletButton`) that connects a wallet via WalletConnect / Reown and sends USDC on Base (mainnet `8453`, testnet Base Sepolia `84532`). Payment is confirmed server-side at `/api/invoices/[slug]/confirm-payment`. Merchants set their receiving wallet per business (`evm_wallet_address`).

48 MCP tools shipped: `whoami`, business profile (3), clients (6), products (6), invoices (16), bank accounts (5), analytics (3), recurring (7), uploads (1). Share links, PDFs, and emails are automatic.

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
TOKEN_ENC_KEY=...                   # AES-256-GCM key for api_tokens at rest: openssl rand -base64 32
CRON_SECRET=...                     # openssl rand -hex 32

# Plus at least one OAuth provider:
AUTH_GITHUB_ID=...
AUTH_GITHUB_SECRET=...
AUTH_GOOGLE_ID=...
AUTH_GOOGLE_SECRET=...

# Optional. features degrade gracefully if absent:
RESEND_API_KEY=...                  # email sending
RESEND_FROM_ADDRESS=...             # sending address (falls back to Resend sandbox)
BLOB_READ_WRITE_TOKEN=...           # logo + attachment uploads (else logo URLs stored verbatim, attachments disabled)
PUBLIC_BASE_URL=http://localhost:3000

# Wallet payments (USDC on Base). Pay button is hidden if unset:
NEXT_PUBLIC_REOWN_PROJECT_ID=...    # WalletConnect / Reown projectId, cloud.reown.com
NEXT_PUBLIC_DEFAULT_CHAIN_ID=8453   # 8453 Base mainnet, 84532 Base Sepolia. Per-business override available
# NEXT_PUBLIC_RPC_URL=...           # optional RPC override, falls back to viem default
# NEXT_PUBLIC_USDC_ADDRESS=...      # optional, defaults to Circle's verified USDC for the chain
```

See `.env.example` for the full annotated list.

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
| `TOKEN_ENC_KEY` | `openssl rand -base64 32`. Encrypts API tokens at rest. Set once and never rotate without re-issuing tokens. |
| `AUTH_URL` | `https://<your-vercel-domain>` (e.g. `enwise.vercel.app`) |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | GitHub OAuth app (create a separate app or add the prod callback to the existing one) |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google OAuth client (add prod callback + origin) |
| `CRON_SECRET` | `openssl rand -hex 32` |
| `PUBLIC_BASE_URL` | `https://<your-vercel-domain>` |
| `RESEND_API_KEY` | [resend.com/api-keys](https://resend.com/api-keys). Verify a domain first or Resend will reject sends. |
| `RESEND_FROM_ADDRESS` | Sending address. For testing leave unset. we fall back to Resend's sandbox (`onboarding@resend.dev`), which only delivers to the Resend account owner's address. For production, verify a domain in Resend and set this to e.g. `invoices@yourdomain.com`. |
| `RESEND_REPLY_TO` | Optional. Server-wide fallback for the `List-Unsubscribe` mailto target when a business hasn't configured its own `email_reply_to`. Defaults to `RESEND_FROM_ADDRESS`. |
| `NEXT_PUBLIC_REOWN_PROJECT_ID` | WalletConnect / Reown projectId from [cloud.reown.com](https://cloud.reown.com). Required for the Pay-with-USDC button. |
| `NEXT_PUBLIC_DEFAULT_CHAIN_ID` | `8453` (Base mainnet) for prod, `84532` (Base Sepolia) for testing. Platform fallback when a business hasn't set its own `payment_chain_id`. |
| `NEXT_PUBLIC_RPC_URL` | Optional RPC override (Alchemy / Infura / QuickNode). Falls back to viem's chain default. |
| `NEXT_PUBLIC_USDC_ADDRESS` | Optional. Defaults to Circle's verified USDC address for the selected chain. |

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
├─ api/invoices/[slug]/confirm-payment  # server-side USDC payment confirmation
└─ i/[slug]/          # public invoice page + PDF + PayWithWalletButton

lib/
├─ db/                # Drizzle schema + client + migrations
├─ mcp/               # MCP server + per-entity tool handlers
├─ web3/              # chain config + wagmi/WalletConnect providers
├─ pdf/               # React-PDF rendering
├─ email/             # Resend wrappers
├─ storage/           # Vercel Blob helpers + SSRF guard
├─ uploads/           # presigned PUT mint for attachment uploads
├─ analytics.ts       # client/revenue/outstanding aggregates
├─ recurring.ts       # recurring-invoice service + runner
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
- [x] **Phase 8 (audit pass)**. SSRF guard, send idempotency, paid badge, dashboard overview, `/api/health`
- [x] **Phase 9**. wallet payments. USDC on Base via WalletConnect / Reown, per-business receiving wallet, bank-account tools, server-side payment confirmation
