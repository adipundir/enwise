# enwise — root Makefile
#
# Quickstart:
#   make install      # install interface deps
#   make dev          # start Next.js dev server on :3000
#   make build        # production build
#   make db-migrate   # apply pending Drizzle migrations against DATABASE_URL

INTERFACE := interface

.PHONY: help
help:
	@grep -E '^[a-zA-Z][a-zA-Z0-9_-]*:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

# ───────── Setup ────────────────────────────────────────────────────────────

.PHONY: install
install: ## Install interface deps
	cd $(INTERFACE) && npm install

.PHONY: clean
clean: ## Remove build artifacts (keeps node_modules)
	cd $(INTERFACE) && rm -rf .next tsconfig.tsbuildinfo

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

# ───────── Aggregate ────────────────────────────────────────────────────────

.PHONY: check
check: lint typecheck ## Lint + typecheck (CI-shape)

.DEFAULT_GOAL := help
