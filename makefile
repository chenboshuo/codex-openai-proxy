HOST ?= 0.0.0.0
PORT ?= 8787

.PHONY: run

run:
	proxychains4 npx --yes . --host $(HOST) --port $(PORT)
