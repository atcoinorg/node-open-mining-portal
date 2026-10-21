DOCKER ?= sudo docker
COMPOSE = $(DOCKER) compose -f docker-compose.yml

.DEFAULT_GOAL := up
.PHONY: up down stop rm restart logs ps install pool check test rpc-config

up: rpc-config
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

stop:
	$(COMPOSE) stop

rm:
	$(COMPOSE) rm -f

restart: rpc-config
	$(COMPOSE) up -d --build --force-recreate

logs:
	$(COMPOSE) logs -f

ps:
	$(COMPOSE) ps

rpc-config:
	$(DOCKER) run --rm --user "$$(id -u):$$(id -g)" -v "$(CURDIR):/app" -w /app node:22-bookworm node scripts/setup-config.js --node

install:
	$(COMPOSE) build npm

pool: up

check:
	$(COMPOSE) exec -T npm node scripts/check.js

test:
	$(COMPOSE) exec -T npm npm test
