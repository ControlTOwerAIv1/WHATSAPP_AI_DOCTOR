# ===================================================================
# Voice Processing Microservice — Makefile
# ===================================================================
# Usage: make <target>
# ===================================================================

.PHONY: help setup dev test lint docker-up docker-down docker-build clean

# Default target
help: ## Show this help message
	@echo "Available targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ── Local Development ────────────────────────────────────────────────

setup: ## Set up local development environment
	python -m pip install --upgrade pip
	pip install -r requirements.txt
	cp -n .env.example .env 2>/dev/null || true
	mkdir -p storage/audio storage/generated
	@echo "Setup complete. Edit .env with your API keys."

dev: ## Start the development server with hot reload
	uvicorn main:app --host 0.0.0.0 --port 8000 --reload

worker: ## Start the Celery worker
	celery -A tasks.celery_worker worker --loglevel=info --concurrency=4

# ── Testing ──────────────────────────────────────────────────────────

test: ## Run all tests with coverage
	pytest tests/ -v --cov=. --cov-report=term-missing --cov-report=html

test-unit: ## Run unit tests only
	pytest tests/unit/ -v --cov=. --cov-report=term-missing

test-integration: ## Run integration tests only (requires Docker services)
	pytest tests/integration/ -v

# ── Code Quality ─────────────────────────────────────────────────────

lint: ## Run linters (ruff)
	ruff check .
	ruff format --check .

format: ## Auto-format code
	ruff format .
	ruff check --fix .

# ── Docker ───────────────────────────────────────────────────────────

docker-build: ## Build Docker images
	docker compose -f docker/docker-compose.yml build

docker-up: ## Start all services via Docker Compose
	docker compose -f docker/docker-compose.yml up -d
	@echo "Services starting..."
	@echo "  API:            http://localhost:8000"
	@echo "  API Docs:       http://localhost:8000/docs"
	@echo "  Health:         http://localhost:8000/health"
	@echo "  LibreTranslate: http://localhost:5000"

docker-down: ## Stop all Docker services
	docker compose -f docker/docker-compose.yml down

docker-logs: ## Tail Docker logs
	docker compose -f docker/docker-compose.yml logs -f

docker-restart: ## Restart all Docker services
	docker compose -f docker/docker-compose.yml restart

# ── Cleanup ──────────────────────────────────────────────────────────

clean: ## Remove generated files and caches
	rm -rf storage/audio/*
	rm -rf storage/generated/*
	rm -rf __pycache__ **/__pycache__
	rm -rf .pytest_cache htmlcov .coverage
	rm -rf .ruff_cache
	@echo "Cleaned."
