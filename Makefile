# ZoikoPay developer targets. Tools are pinned in tools/go.mod and run with
# `go tool`, so nothing needs installing globally beyond Go and Docker.

SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

COMPOSE      := docker compose -f deploy/compose/compose.yaml
TOOL         := go tool -modfile=tools/go.mod
SPECTRAL_IMG := stoplight/spectral:6.15.0

ZP_PG_PORT           ?= 55432
ZP_MIGRATOR_PASSWORD ?= local-dev-only-migrator
ZP_MIGRATOR_DSN      ?= postgres://zp_migrator:$(ZP_MIGRATOR_PASSWORD)@localhost:$(ZP_PG_PORT)/zoikopay?sslmode=disable

OPENAPI_SPECS := $(wildcard api/openapi/*.v1.yaml)
MIGRATION_DIRS := $(sort $(dir $(wildcard db/migrations/*/*.sql)))

.PHONY: help
help: ## List targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-18s %s\n",$$1,$$2}'

## ---- local stack -----------------------------------------------------------

.PHONY: up
up: ## Start the local stack and wait until healthy
	$(COMPOSE) up -d --wait

.PHONY: down
down: ## Stop the local stack (keeps volumes; use `make nuke` to drop them)
	$(COMPOSE) down

.PHONY: nuke
nuke: ## Stop the local stack and delete its volumes (all local data)
	$(COMPOSE) down -v

.PHONY: ps
ps: ## Show local stack status
	$(COMPOSE) ps

## ---- code generation -------------------------------------------------------

# sqlc refuses a config with no modules, so it runs only once sqlc.yaml lists one.
SQLC_HAS_MODULES := $(shell grep -qE '^[[:space:]]*-[[:space:]]*engine:' sqlc.yaml 2>/dev/null && echo yes)

.PHONY: gen
gen: ## Run sqlc and oapi-codegen
	@if [ -n "$(SQLC_HAS_MODULES)" ]; then echo "sqlc generate"; $(TOOL) sqlc generate; \
	  else echo "sqlc: sqlc.yaml lists no modules yet; skipped"; fi
	@for spec in $(OPENAPI_SPECS); do \
	  cfg="$${spec%.yaml}.codegen.yaml"; \
	  if [ -f "$$cfg" ]; then echo "oapi-codegen $$spec"; $(TOOL) oapi-codegen -config "$$cfg" "$$spec"; fi; \
	done

.PHONY: check-gen
check-gen: gen ## Fail if generated code is stale (CI; needs git)
	@if [ -n "$(SQLC_HAS_MODULES)" ]; then $(TOOL) sqlc diff; fi
	@git diff --exit-code -- . || { echo "generated code is stale: run 'make gen' and commit"; exit 1; }
	@test -z "$$(git status --porcelain --untracked-files=all)" || { git status --porcelain; echo "untracked generated files: run 'make gen' and commit"; exit 1; }

## ---- database --------------------------------------------------------------

.PHONY: migrate
migrate: ## Apply every module's migrations (as zp_migrator)
	@if [ -z "$(MIGRATION_DIRS)" ]; then echo "migrate: no migrations yet"; fi
	@for dir in $(MIGRATION_DIRS); do \
	  mod=$$(basename $$dir); echo "migrate $$mod"; \
	  $(TOOL) goose -dir $$dir -table zp_migrations.goose_$$mod postgres "$(ZP_MIGRATOR_DSN)" up; \
	done

.PHONY: migrate-status
migrate-status: ## Show migration status per module
	@for dir in $(MIGRATION_DIRS); do \
	  mod=$$(basename $$dir); echo "== $$mod"; \
	  $(TOOL) goose -dir $$dir -table zp_migrations.goose_$$mod postgres "$(ZP_MIGRATOR_DSN)" status; \
	done

## ---- quality ---------------------------------------------------------------

.PHONY: build
build: ## Build all binaries into bin/
	go build -trimpath -o bin/ ./cmd/...

.PHONY: lint
lint: lint-go lint-openapi ## Run all linters

.PHONY: lint-go
lint-go: ## golangci-lint (includes integration-tagged files)
	$(TOOL) golangci-lint run ./...

.PHONY: lint-openapi
lint-openapi: ## Spectral lint of OpenAPI contracts (Docker)
	@if [ -z "$(OPENAPI_SPECS)" ]; then echo "lint-openapi: no OpenAPI specs yet (M2)"; else \
	  docker run --rm -v "$(CURDIR):/work:ro" -w /work $(SPECTRAL_IMG) lint --fail-severity=warn \
	    --ruleset api/openapi/.spectral.yaml $(OPENAPI_SPECS); fi

.PHONY: vuln
vuln: ## govulncheck
	$(TOOL) govulncheck ./...

.PHONY: test
test: ## Unit tests with the race detector (no Docker needed)
	go test -race -count=1 ./...

.PHONY: smoke
smoke: build ## Start all six binaries against the local stack, check /healthz, stop them
	scripts/smoke.sh

# `make run-<service>` runs one binary against the local stack, for example
# `make run-execution`. Services: gateway execution finance governance outbox-relay mockpsp.
run-%:
	scripts/local-env.sh $* go run ./cmd/$*

.PHONY: test-integration
test-integration: ## Integration tests (Testcontainers; needs Docker)
	go test -race -count=1 -tags integration -timeout 15m ./...

.PHONY: tidy
tidy: ## go mod tidy for app and tools modules
	go mod tidy
	cd tools && go mod tidy
