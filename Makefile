# enwise — root Makefile
# Ties contract + interface workflows together so testing the private-payments
# loop is one command.
#
# Quickstart (everything runs against Base Sepolia):
#   make install          # deps in both workspaces
#   make compile          # compile contracts
#   make test             # contract tests + interface typecheck
#   make deploy-testnet   # deploy EnwisePay to Base Sepolia
#   make dev              # start Next.js dev server
#
# See `make help` for the full list.

INTERFACE := interface
CONTRACT  := contract

# ───────── Help ─────────────────────────────────────────────────────────────

.PHONY: help
help:
	@grep -E '^[a-zA-Z][a-zA-Z0-9_-]*:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

# ───────── Setup ────────────────────────────────────────────────────────────

.PHONY: install
install: install-contract install-interface ## Install deps in both workspaces

.PHONY: install-contract
install-contract: ## Install contract deps
	cd $(CONTRACT) && npm install

.PHONY: install-interface
install-interface: ## Install interface deps
	cd $(INTERFACE) && npm install

.PHONY: clean
clean: ## Remove build artifacts (keeps node_modules)
	cd $(CONTRACT) && rm -rf artifacts cache typechain-types ignition/deployments
	cd $(INTERFACE) && rm -rf .next tsconfig.tsbuildinfo

.PHONY: clean-all
clean-all: clean ## Remove build artifacts AND node_modules
	cd $(CONTRACT) && rm -rf node_modules
	cd $(INTERFACE) && rm -rf node_modules

# ───────── Contract (Base Sepolia) ──────────────────────────────────────────

.PHONY: compile
compile: ## Compile contracts
	cd $(CONTRACT) && npx hardhat compile

.PHONY: test-contract
test-contract: ## Run contract unit tests (in-memory hardhat network)
	cd $(CONTRACT) && npx hardhat test

.PHONY: test-contract-testnet
test-contract-testnet: ## Run contract tests against Base Sepolia
	cd $(CONTRACT) && npm run test:testnet

.PHONY: deploy-testnet
deploy-testnet: ## Deploy EnwisePay to Base Sepolia
	cd $(CONTRACT) && npm run deploy:testnet

.PHONY: verify
verify: ## Verify contract on Basescan (set ADDR=0x... and RELAYER=0x...)
	@if [ -z "$(ADDR)" ] || [ -z "$(RELAYER)" ]; then \
		echo "usage: make verify ADDR=0xDeployedAddr RELAYER=0xRelayerEoa"; exit 1; fi
	cd $(CONTRACT) && npx hardhat verify --network baseSepolia $(ADDR) 0x000000000022D473030F116dDEE9F6B43aC78BA3 $(RELAYER)

# ───────── Interface ────────────────────────────────────────────────────────

.PHONY: dev
dev: ## Start Next.js dev server on :3000
	cd $(INTERFACE) && npm run dev

.PHONY: build
build: ## Production build of interface
	cd $(INTERFACE) && npm run build

.PHONY: lint
lint: ## ESLint interface
	cd $(INTERFACE) && npm run lint

.PHONY: typecheck
typecheck: ## TypeScript check (no emit) for interface
	cd $(INTERFACE) && npx tsc --noEmit

# ───────── Database ─────────────────────────────────────────────────────────

.PHONY: db-generate
db-generate: ## Generate drizzle migrations from schema diff
	cd $(INTERFACE) && npm run db:generate

.PHONY: db-push
db-push: ## Push schema to DATABASE_URL (dev only)
	cd $(INTERFACE) && npm run db:push

.PHONY: db-migrate
db-migrate: ## Apply generated migrations (prod-safe)
	cd $(INTERFACE) && npm run db:migrate

.PHONY: db-studio
db-studio: ## Open drizzle studio on :4983
	cd $(INTERFACE) && npm run db:studio

# ───────── Smoke tests + manual cron triggers ───────────────────────────────

.PHONY: smoke-private
smoke-private: ## Smoke test private payments SDK connectivity (Base Sepolia)
	cd $(INTERFACE) && npx tsx scripts/smoke-private.ts

.PHONY: smoke-mcp
smoke-mcp: ## Smoke test the MCP server
	cd $(INTERFACE) && npm run smoke:mcp

.PHONY: e2e
e2e: ## Run the end-to-end private payments shield → sweep test on Base Sepolia
	cd $(INTERFACE) && npx tsx scripts/e2e-private.ts

.PHONY: sweep
sweep: ## Trigger the sweep cron locally (requires CRON_SECRET in env)
	@if [ -z "$$CRON_SECRET" ]; then echo "CRON_SECRET not set; export it first"; exit 1; fi
	curl -sS -H "Authorization: Bearer $$CRON_SECRET" http://localhost:3000/api/cron/sweep-private | jq

.PHONY: index
index: ## Trigger the Shielded-event indexer cron locally
	@if [ -z "$$CRON_SECRET" ]; then echo "CRON_SECRET not set; export it first"; exit 1; fi
	curl -sS -H "Authorization: Bearer $$CRON_SECRET" http://localhost:3000/api/cron/index-shielded | jq

# ───────── Aggregate ────────────────────────────────────────────────────────

.PHONY: test
test: test-contract typecheck ## Run contract tests + interface typecheck

.PHONY: check
check: lint typecheck test-contract ## Lint + typecheck + contract tests (CI-shape)

.PHONY: fresh
fresh: clean-all install compile ## Nuke + reinstall + recompile

.DEFAULT_GOAL := help
