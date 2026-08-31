SHELL := /bin/bash
.DEFAULT_GOAL := help
.PHONY: help install up down ps logs reset-db migrate seed seed-mock totp \
        mock dev build typecheck lint test test-e2e \
        demo demo-stop demo-status demo-logs demo-restart-api demo-reset \
        psql redis-cli clean

# --- Configuration -----------------------------------------------------------
# Override any of these on the command line, e.g. `make seed SEED_PIKVM_HOST=https://10.0.0.5`
SEED_PIKVM_HOST     ?= https://192.168.1.50
SEED_PIKVM_USER     ?= admin
SEED_PIKVM_PASSWORD ?= admin

MOCK_PORT := 8443
API_PORT  := 3000
WEB_PORT  := 5173

MOCK_HOST := http://localhost:$(MOCK_PORT)
API_URL   := http://localhost:$(API_PORT)
WEB_URL   := http://localhost:$(WEB_PORT)

DEMO_DIR  := .demo
MOCK_LOG  := $(DEMO_DIR)/mock-pikvm.log
API_LOG   := $(DEMO_DIR)/api.log
WEB_LOG   := $(DEMO_DIR)/web.log

# --- Help --------------------------------------------------------------------

help: ## Show this help
	@echo "CROP -- Clinical Remote Operation Platform"
	@echo ""
	@echo "Everyday commands:"
	@echo ""
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# --- Setup ---------------------------------------------------------------

install: ## Install all workspace dependencies (pnpm)
	pnpm install

up: ## Start Postgres, Redis, and MediaMTX (docker compose), and wait until healthy
	docker compose up -d --wait

down: ## Stop Postgres, Redis, and MediaMTX (data volumes are kept)
	docker compose down

ps: ## Show status of docker compose infra services
	docker compose ps

migrate: ## Apply Prisma migrations to the dev database
	pnpm --filter @crop/api exec prisma migrate deploy

reset-db: ## Drop and recreate the dev database, reapplying all migrations (destructive)
	pnpm --filter @crop/api exec prisma migrate reset --force --skip-generate

# --- Data ----------------------------------------------------------------

seed: ## Seed demo tenants/users/equipment/queue against a REAL PiKVM (see SEED_PIKVM_* vars)
	SEED_PIKVM_HOST=$(SEED_PIKVM_HOST) SEED_PIKVM_USER=$(SEED_PIKVM_USER) SEED_PIKVM_PASSWORD=$(SEED_PIKVM_PASSWORD) pnpm db:seed

seed-mock: ## Seed demo data pointed at the local mock PiKVM instead (no hardware needed)
	SEED_PIKVM_HOST=$(MOCK_HOST) SEED_PIKVM_USER=admin SEED_PIKVM_PASSWORD=admin pnpm db:seed

totp: ## Print each seeded user's email, password, and a currently-valid TOTP code
	@pnpm totp

# --- Quality gates ---------------------------------------------------------

build: ## Build every workspace package/app
	pnpm build

typecheck: ## Typecheck every workspace package/app
	pnpm typecheck

lint: ## Lint every workspace package/app
	pnpm lint

test: ## Run unit tests across every workspace package/app
	pnpm test

test-e2e: ## Run the API's full e2e suite (needs `make up` running first)
	pnpm --filter @crop/api test:e2e

# --- Manual / foreground processes ------------------------------------------

mock: ## Run the mock PiKVM server in the foreground (Ctrl-C to stop)
	pnpm spike:mock

dev: ## Run the API and web dev servers in the foreground, against real PiKVM (Ctrl-C to stop)
	pnpm dev

# --- Full local demo, no PiKVM hardware required ----------------------------
# Starts infra + a mock PiKVM + the API + the web app in the background, logged to
# .demo/*.log. Everything works end to end except real video decode -- see
# docs/architecture.md.
#
# Shutdown is done by command-line *pattern* (pkill -f), not by pidfile or by whatever
# process happens to hold the port: each of these is launched through pnpm, which forks
# several layers of its own wrapper processes before the real server ever starts (pnpm ->
# pnpm (linked binary) -> [pnpm --filter ... exec tsx ->] the actual server). A pidfile only
# ever captures the outermost layer, and killing just the port-holder leaves every wrapper
# above it orphaned, running forever. Two patterns per service (the wrapper layers, and the
# real leaf process) reliably catches the whole tree in one shot. Requires `pkill`/`lsof`
# (present by default on macOS and virtually every Linux dev setup).

demo: up ## Start the full no-hardware demo stack in the background
	@mkdir -p $(DEMO_DIR)
	@if lsof -i tcp:$(MOCK_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "Mock PiKVM already running on port $(MOCK_PORT)."; \
	else \
		echo "Starting mock PiKVM on $(MOCK_HOST)..."; \
		nohup pnpm spike:mock > $(MOCK_LOG) 2>&1 & \
		sleep 1; \
	fi
	@echo "Applying migrations..."
	@$(MAKE) --no-print-directory migrate
	@user_count=$$(docker compose exec -T postgres psql -U crop -d crop -tAc "SELECT count(*) FROM users" 2>/dev/null | tr -d '[:space:]'); \
	if [ "$${user_count:-0}" -gt 0 ] 2>/dev/null; then \
		echo "Database already has $$user_count user(s) -- skipping seed (use 'make demo-reset' to start fresh)."; \
	else \
		echo "Seeding demo data against the mock PiKVM..."; \
		$(MAKE) --no-print-directory seed-mock; \
	fi
	@if lsof -i tcp:$(API_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "API dev server already running on port $(API_PORT)."; \
	else \
		echo "Starting API dev server on $(API_URL)..."; \
		nohup pnpm --filter @crop/api dev > $(API_LOG) 2>&1 & \
	fi
	@if lsof -i tcp:$(WEB_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "Web dev server already running on port $(WEB_PORT)."; \
	else \
		echo "Starting web dev server on $(WEB_URL)..."; \
		nohup pnpm --filter @crop/web dev > $(WEB_LOG) 2>&1 & \
	fi
	@echo -n "Waiting for the API to come up"
	@for i in 1 2 3 4 5 6 7 8 9 10 11 12; do \
		if lsof -i tcp:$(API_PORT) -sTCP:LISTEN >/dev/null 2>&1; then echo ""; break; fi; \
		echo -n "."; sleep 2; \
	done
	@echo ""
	@$(MAKE) --no-print-directory demo-status
	@echo ""
	@echo "Demo is up:"
	@echo "  Web:        $(WEB_URL)"
	@echo "  API:        $(API_URL)"
	@echo "  Mock PiKVM: $(MOCK_HOST)"
	@echo ""
	@echo "Run 'make totp' for login codes, 'make demo-logs' to tail logs,"
	@echo "'make demo-stop' to shut everything down."

demo-status: ## Check whether the demo's background processes are still alive
	@for pair in "Mock PiKVM:$(MOCK_PORT)" "API:$(API_PORT)" "Web:$(WEB_PORT)"; do \
		name=$${pair%%:*}; port=$${pair#*:}; \
		pid=$$(lsof -ti tcp:$$port -sTCP:LISTEN 2>/dev/null); \
		if [ -n "$$pid" ]; then \
			echo "  $$name (port $$port): running (pid $$pid)"; \
		else \
			echo "  $$name (port $$port): not running"; \
		fi; \
	done

demo-logs: ## Tail all three demo process logs together
	@tail -f $(MOCK_LOG) $(API_LOG) $(WEB_LOG)

demo-restart-api: ## Restart just the API dev server (e.g. after changing .env)
	@pkill -f "@crop/api dev" 2>/dev/null || true
	@pkill -f "nest.js start --watch" 2>/dev/null || true
	@sleep 1
	@nohup pnpm --filter @crop/api dev > $(API_LOG) 2>&1 &
	@echo "API dev server restarting -- tail $(API_LOG) or run 'make demo-status' to confirm."

demo-reset: ## Wipe and reseed the demo database against the mock PiKVM (keeps servers running)
	@$(MAKE) --no-print-directory reset-db
	@$(MAKE) --no-print-directory seed-mock

demo-stop: ## Stop all background demo processes (leaves docker compose infra running)
	@pkill -f "spike:mock" 2>/dev/null || true
	@pkill -f "mock-pikvm-server.ts" 2>/dev/null || true
	@pkill -f "@crop/api dev" 2>/dev/null || true
	@pkill -f "nest.js start --watch" 2>/dev/null || true
	@pkill -f "@crop/web dev" 2>/dev/null || true
	@pkill -f "vite/bin/vite.js" 2>/dev/null || true
	@echo "Demo processes stopped. Infra containers still running -- 'make down' to stop those too."

# --- Convenience -----------------------------------------------------------

psql: ## Open a psql shell against the dev database
	docker compose exec postgres psql -U crop -d crop

redis-cli: ## Open a redis-cli shell against the dev Redis
	docker compose exec redis redis-cli

clean: ## Remove build output and caches (does not touch docker volumes or .env files)
	pnpm -r exec rm -rf dist .turbo
	rm -rf .turbo
