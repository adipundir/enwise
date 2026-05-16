# enwise demo prep — laptop + Brave + MetaMask

## The Brave gotcha (fix this first)

Brave ships its own wallet that hijacks `window.ethereum`. With both Brave Wallet and MetaMask enabled, MetaMask doesn't get the request — Brave Wallet does. The code now uses EIP-6963 + provider-list discovery to prefer MetaMask, but the cleanest path is to disable Brave's default:

1. Address bar: `brave://settings/wallet`
2. Default crypto wallet → **Extensions (no fallback)**
3. Restart Brave

If you skip this, the `/sign-settlement` page will warn you and offer the workaround inline. The PrivatePayButton (customer side) silently picks MetaMask via EIP-6963.

## Pre-demo checklist (do all of this *before* you start screen-sharing)

### 1. Funded relayer wallet
```bash
cat interface/.env | grep RELAYER_EOA_ADDRESS
```
Visit https://sepolia-faucet.pk910.de or https://www.alchemy.com/faucets/base-sepolia. Drip ~0.5 Base Sepolia ETH to that address. Verify on https://sepolia.basescan.org.

### 2. Two MetaMask accounts in Brave
| Account | Role | Needs |
|---|---|---|
| Account 1 = "Merchant" | demoes `setup_private_payments` proof flow + receives swept USDC | Base Sepolia network added |
| Account 2 = "Customer" | pays the invoice | Base Sepolia ETH (~0.001 for Permit2 approve), Base Sepolia USDC (≥ invoice amount) |

Add Base Sepolia to MetaMask:
- Network name: `Base Sepolia`
- RPC: `https://sepolia.base.org`
- Chain ID: `84532`
- Currency: `ETH`
- Explorer: `https://sepolia.basescan.org`

Or just hit https://chainlist.org/chain/84532 and click "Connect Wallet".

### 3. Customer wallet has Base Sepolia USDC
Circle's official faucet: https://faucet.circle.com → pick Base Sepolia → drip 100 USDC to Account 2.

USDC contract on Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. After dripping, MetaMask might not show USDC by default — click "Import token" in the Assets tab and paste that address.

### 4. Customer wallet has Base Sepolia ETH
Same faucet as relayer (~0.01 ETH is plenty). Customer needs gas for the one-time `USDC.approve(Permit2)` tx; everything after that is gasless for them.

### 5. Contract deployed + env set
```bash
cd contract
make deploy-testnet                 # if not already done
# Copy the deployed address from Ignition output → interface/.env as NEXT_PUBLIC_ENWISE_PAY_ADDRESS
```
```bash
cd interface
grep NEXT_PUBLIC_ENWISE_PAY_ADDRESS .env  # confirm it's set
```

### 6. DB migrated
```bash
make db-push                        # applies 0017 (add private payments cols) + 0018 (drop legacy private-payment cols)
```

### 7. Smoke
```bash
make smoke-private                     # confirms private payments SDK reaches the testnet covalidator
```
Should print the executor address and the encrypted ct of a sample address.

### 8. Dev server up
```bash
make dev
```
Visit http://localhost:3000, sign in via OAuth (you can do this in advance), generate an MCP API token from the dashboard, paste into Claude.

## Demo script (what to say to Claude)

Total runtime: ~5–7 minutes.

### Act 1 — Onboarding (0:00 → 1:30)

> "Create a business called Acme Consulting in USD. I want private payments enabled — I'll prove ownership of my wallet via signature."

Claude should:
1. Call `whoami` → sees no businesses, gets onboarding hint
2. Call `create_business({ name: "Acme Consulting", default_currency: "USD" })`
3. Call `request_settlement_wallet_proof({ candidate: <Account 1's address you give it> })` — returns `signing_url`

You: click the URL → opens `/sign-settlement?m=…` in Brave. The page connects MetaMask, you click "Sign and confirm", message pops up in MetaMask, you click Sign. Page shows ✓.

> "Done."

Claude calls `whoami` again → sees `private_settlement_wallet` set with verified=true.

### Act 2 — Profile + first client (1:30 → 2:30)

> "My address is 123 Main St, Wilmington DE 19801, US. Tax ID is 12-3456789. Add a client called Initech, email contact@initech.com."

Claude calls `update_business_profile` then `create_client`.

### Act 3 — Issue invoice (2:30 → 3:30)

> "Invoice Initech $50 USDC for May consulting hours."

Claude calls `create_invoice`. Behind the scenes, `maybeBuildPrivateFields()` runs `zap.encrypt(merchant_address)`, stores the ct on the invoice. Returns the share URL.

> "Send it."

Claude calls `send_invoice`. Email goes out (or skip if you don't want to wait for SMTP).

### Act 4 — Customer pays (3:30 → 5:00)

Open the share URL **in a new Brave window** (so it picks up Account 2 in MetaMask), or switch to Account 2 in your existing MetaMask.

Click "Pay 50 USDC privately (private)":
1. MetaMask prompts to switch to Base Sepolia (if not already on it).
2. **First time**: MetaMask prompts `USDC.approve(Permit2, max)` — confirm. ~1 sec.
3. MetaMask prompts to sign Permit2 typed data — confirm. **No gas.**
4. Page shows "Submitted! Tx: 0x…". Click the tx link → Basescan.

Behind the scenes the relayer just submitted `EnwisePay.payInvoice(...)` and the chain shows:
- `Shielded(noteId=1, slug=0x…, asset=USDC, amount=50_000_000)`

### Act 5 — Sweep (5:00 → 6:00)

Default cron timing is 2-min indexer + 5-min sweep. **For a live demo, trigger manually** so you don't dead-air for 7 minutes:

```bash
# in another terminal:
export CRON_SECRET=<your value from interface/.env>
make index    # wires noteId onto invoice
make sweep    # runs attestedCompute + unShield
```

Watch the merchant wallet (Account 1) — 50 USDC arrives within ~10–15 seconds (covalidator + sweep tx confirmation).

Now ask Claude:
> "What's the status of the invoice?"

Claude calls `get_invoice` → status is `paid`, both tx hashes set. Loop closed.

## Things to mention out loud during the demo

**During Act 1 (signing):**
> "Notice this is just signing a message. No gas. No on-chain tx. We're proving control of the address before binding it as the merchant's settlement wallet, so a typo or social-engineering attack can't redirect funds."

**During Act 4 (paying):**
> "The customer signed a Permit2 typed-data message — also gasless. The actual transaction is being broadcast by enwise's relayer. The customer never paid gas in ETH, never had to top up a custom wallet, just signed once."

**During Act 5 (sweep):**
> "The merchant's address was encrypted in the invoice link. Onchain right now, you see USDC arrived at our contract — but you can't see who. The covalidator just attested that yes, the encrypted recipient equals my wallet, and the contract released the funds."

## Failure-mode rehearsal

| Symptom | Likely cause | Fast fix |
|---|---|---|
| `/sign-settlement` shows "Brave Wallet" with the amber warning | Brave default not changed | Click into `brave://settings/wallet`, change it, refresh |
| MetaMask never opens when you click "Connect" | Multiple wallets fighting; EIP-6963 didn't find MetaMask | Pin MetaMask to toolbar; disable other wallet extensions |
| `setup_private_payments` works but `whoami` doesn't show it | DB push not done | `make db-push` |
| `payInvoice` reverts with "fee" error | relayer out of ETH | Top up via faucet; relayer needs ~0.0005 ETH per shield |
| `attestedCompute` hangs on sweep | private payments testnet covalidator slow / down | Wait 30s and retry; backoff is built in (5x, 2s/4s/8s/16s/32s) |
| Customer wallet says "Insufficient funds" on Permit2 approve | Account 2 has no Base Sepolia ETH | Drip from faucet |
| Customer wallet shows USDC balance 0 | Token not imported; or wrong network | Add USDC token by address `0x036C…F7e`; switch to Base Sepolia |
| Permit2 sign popup shows raw hex instead of structured data | Old MetaMask version | Update MetaMask to latest |

## What you should *not* show on stream

- `RELAYER_PRIVATE_KEY` from `interface/.env`
- Customer's seed phrase
- Merchant's seed phrase
- The Alchemy API key in any RPC URL (use the public `https://sepolia.base.org` if you're not sure)

Use a separate Brave profile or guest window for the demo so your real browsing tabs aren't visible.

## Optional polish (only if you have ~30 min before the demo)

- Pre-create the merchant business and client off-stream — saves Act 2 time. Then Act 1 is just the signing flow on a fresh business.
- Pre-fund Customer wallet with 100 USDC so you don't waste demo time waiting for faucet.
- Have the share URL pre-loaded in Account 2's tab — saves clicking around.
- Run `make sweep` ahead of time on a dummy note to confirm the cron path works.

## After the demo

```bash
# show the chain footprint
echo "All private payments events on EnwisePay:"
# basescan: https://sepolia.basescan.org/address/<NEXT_PUBLIC_ENWISE_PAY_ADDRESS>#events
```

Show two events: `Shielded(noteId, slug, USDC, 50_000_000)` and `Unshielded(noteId, merchant_address)`. Make the point: privacy boundary is "chain observers" — enwise sees everything off-chain, observers see only the encrypted handle until sweep.
