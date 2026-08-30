HOST ?= 0.0.0.0
PORT ?= 8787

.PHONY: help install build run

## make help: show this message.
help:
	grep -h -E '^##' ${MAKEFILE_LIST} | sed -e 's/## //g' | column -t -s ':'

## make run: start the proxy server.
run: build
	proxychains4 node dist/cli.js --host $(HOST) --port $(PORT)

## make build: compile TypeScript sources.
build: node_modules
	npm run build

## make install: install dependencies from the lockfile.
install: node_modules

node_modules: package.json package-lock.json
	npm ci
	touch node_modules
