# enwise

Invoicing from inside Claude. enwise is an MCP server that runs an entire invoicing business through natural language, paired with a Next.js web app for hosted invoices, PDFs, and USDC wallet payments. Clients, invoices, emails, PDFs, recurring billing, and analytics are all driven by conversation.

## Repo layout

```
.
├── interface/        Next.js 16 app + MCP server (the product)
├── eth-skills/        reference skills (not part of the app build)
├── Makefile           dev / build / db tasks (delegates into interface/)
└── *.pdf              pitch decks (gitignored output dir)
```

Everything that ships lives in `interface/`. The Makefile at the root is a thin wrapper around the interface npm scripts.

## What it does

- **MCP server** (`app/api/mcp/route.ts`, `lib/mcp/`) exposes the whole business as tools: `whoami`, business profile, clients, products, invoices, bank accounts, recurring templates, uploads, and analytics. Point Claude at it and operate everything by chat.
- **Multi-business accounts.** One user can own many businesses, each with its own invoice numbering. Clients and products are shared at the account level.
- **Hosted invoices** at `/i/[slug]` with a Download PDF route and a receipt PDF route.
- **Wallet payments.** Pay invoices in USDC on Base (`8453`) and Arbitrum One (`42161`) via WalletConnect / Reown. Merchants set accepted chains per business; payers pick at checkout. On-chain verification uses Alchemy RPC.
- **Transactional email** via Resend, with React Email templates in `emails/`.
- **Recurring invoices** run on a Vercel Cron route (`app/api/cron/recurring/`).
- **Auth** via Auth.js (GitHub / Google OAuth). API tokens are encrypted at rest (AES-256-GCM).

## Stack

Next.js 16 (App Router, React 19), Drizzle ORM on Neon Postgres, Auth.js v5, `@modelcontextprotocol/sdk`, viem + wagmi for web3, `@react-pdf/renderer` for PDFs, Resend for email, Vercel Blob for uploads, Tailwind v4, Zod, TypeScript.

## Getting started

```bash
make install          # install interface deps
cp interface/.env.example interface/.env   # then fill in the values below
make db-migrate       # apply Drizzle migrations against DATABASE_URL
make dev              # Next.js dev server on :3000
```

`make help` lists every task.

### Required environment

Copy `interface/.env.example` to `interface/.env` and fill it in. The essentials:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres (pooled) connection string |
| `AUTH_SECRET` | Auth.js secret (`openssl rand -base64 32`) |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | GitHub OAuth (or use Google) |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google OAuth (or use GitHub) |
| `AUTH_URL` | Canonical app URL (`http://localhost:3000` in dev) |
| `TOKEN_ENC_KEY` | AES-256-GCM key for API tokens (`openssl rand -base64 32`) |

Add as you enable more: `BLOB_READ_WRITE_TOKEN` (logo uploads), `RESEND_API_KEY` + `RESEND_FROM_ADDRESS` (email), `CRON_SECRET` (recurring cron), `PUBLIC_BASE_URL` (share links), `NEXT_PUBLIC_DEFAULT_CHAIN_ID`, `NEXT_PUBLIC_REOWN_PROJECT_ID` (wallet payments), and the Alchemy RPC vars below. See `interface/.env.example` for the full list and notes.

| Variable | Purpose |
|---|---|
| `BASE_RPC_URL` | Alchemy RPC for Base mainnet (`https://base-mainnet.g.alchemy.com/v2/<key>`) |
| `ARBITRUM_RPC_URL` | Alchemy RPC for Arbitrum One (`https://arb-mainnet.g.alchemy.com/v2/<key>`) |
| `ETH_MAINNET_RPC_URL` | Alchemy RPC for Ethereum mainnet, used for USDT payments (`https://eth-mainnet.g.alchemy.com/v2/<key>`) |

Get keys at [dashboard.alchemy.com](https://dashboard.alchemy.com). Falls back to the chain's public RPC if unset, but Alchemy is required in production for reliable payment verification.

For the full local-dev walkthrough, MCP smoke test, Vercel deploy steps, OAuth callback setup, and project layout, see [`interface/README.md`](interface/README.md).

## Common tasks

```bash
make dev          # dev server on :3000
make build        # production build
make check        # lint + typecheck (CI shape)
make db-generate  # generate migrations from schema diff
make db-push      # push schema to DATABASE_URL (dev only)
make db-migrate   # apply migrations (prod-safe)
make db-studio    # Drizzle Studio on :4983
```

## Conventions

This repo pins a specific Next.js version with breaking changes from older releases. Read the relevant guide in `interface/node_modules/next/dist/docs/` before writing app code, and heed deprecation notices. See `AGENTS.md`.

## Deploy notes

Deploy code before running destructive prod migrations (drop column / type / FK), or the live app crashes on the next request.
