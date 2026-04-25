# envoice

An MCP server for running an invoicing business entirely through natural language in Claude. Built on Next.js + Neon Postgres + Vercel.

## What it does

- **MCP server** at `/api/mcp` — Claude calls tools to create invoices, manage clients, send emails, and more.
- **Public invoice page** at `/i/[slug]` — shareable link for recipients with a downloadable PDF.
- **Web dashboard** at `/dashboard` — exists for one reason: signing in and generating an API token. Everything else happens in Claude.

See `/Users/adityapundir/.claude/plans/idempotent-dancing-parrot.md` for the full architecture plan.

## Local development

### 1. Prerequisites

- **Node.js** — this repo uses a user-local install at `~/.local/share/node` (v24.15.0 LTS). `node`/`npm`/`npx` are symlinked into `~/.local/bin`.
- **A Neon Postgres database** — free tier works. Create one at [console.neon.tech](https://console.neon.tech) and grab the pooled connection string.
- **At least one OAuth provider.** Configure either or both:
  - **GitHub** — create an OAuth App at [github.com/settings/developers](https://github.com/settings/developers). Authorization callback URL: `http://localhost:3000/api/auth/callback/github`.
  - **Google** — create an OAuth client at [console.cloud.google.com](https://console.cloud.google.com/apis/credentials). Authorized redirect URI: `http://localhost:3000/api/auth/callback/google`.

### 2. Environment

Fill in the **Phase 0** block of `.env`:

```
DATABASE_URL=postgres://...        # Neon
AUTH_SECRET=...                    # openssl rand -base64 32

# Plus at least one of:
AUTH_GITHUB_ID=...
AUTH_GITHUB_SECRET=...
AUTH_GOOGLE_ID=...
AUTH_GOOGLE_SECRET=...
```

Phase 1+ variables (Upstash, Resend, Blob, etc.) can be left blank until their features land.

### 3. Database setup

```bash
npm run db:generate    # regenerate migration from schema.ts (only if you edited schema)
npm run db:migrate     # apply migrations + create pg_trgm/unaccent extensions + trigram indexes
```

`db:migrate` is idempotent — safe to run whenever.

### 4. Run

```bash
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000).

## Project layout

```
app/                  # Next.js App Router
├─ page.tsx           # public landing
├─ signin/            # custom Auth.js sign-in page
├─ dashboard/         # auth-gated web UI (API tokens + connection instructions)
├─ api/auth/          # Auth.js handlers
├─ api/mcp/           # (Phase 1) MCP server endpoint
├─ api/cron/          # (Phase 7) recurring-invoice cron
└─ i/[slug]/          # (Phase 4) public invoice page + PDF

lib/
├─ db/                # Drizzle schema + client + migrations
├─ mcp/               # (Phase 1+) MCP server + per-entity tool handlers
├─ auth/              # (Phase 1) bearer-token auth middleware
├─ pdf/               # (Phase 4) React-PDF rendering
├─ email/             # (Phase 5) Resend wrappers
├─ storage/           # (Phase 2) Vercel Blob helpers
└─ *.ts               # service layer: businesses, clients, products, invoices, …

auth.ts               # Auth.js v5 config (Google + Drizzle adapter + DB sessions)
drizzle.config.ts     # Drizzle Kit config
```

## Phase status

- [x] **Phase 0** — Next scaffold, Drizzle + Neon, Auth.js Google sign-in, gated dashboard
- [ ] Phase 1 — API tokens + MCP endpoint
- [ ] Phase 2 — Business profile + logo upload
- [ ] Phase 3 — Clients + products
- [ ] Phase 4 — Invoices + public page + PDF
- [ ] Phase 5 — Email sending
- [ ] Phase 6 — Analytics tools
- [ ] Phase 7 — Recurring invoices
- [ ] Phase 8 — Polish
