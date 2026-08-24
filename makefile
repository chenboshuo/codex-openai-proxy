HOST ?= 0.0.0.0
PORT ?= 8787

.PHONY: help run
.ONESHELL:

## make help: show this message.
help:
	grep -h -E '^##' ${MAKEFILE_LIST} | sed -e 's/## //g' | column -t -s ':'

## make run: start the proxy server.
run:
	proxychains4 node dist/cli.js --host $(HOST) --port $(PORT)
