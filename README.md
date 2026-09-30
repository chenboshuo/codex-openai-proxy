[English](./README.md) | [简体中文](./README.zh-CN.md)

# codex-openai-proxy

A local OpenAI-compatible proxy that reuses local Codex / ChatGPT auth state and forwards requests to `https://chatgpt.com/backend-api/codex/*`.

It exposes OpenAI-style endpoints so existing OpenAI SDK integrations and tools can work with minimal changes.

Currently supported:

- `GET /health`
- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/chat/completions`

## Quick Start

### 1. Prerequisites

- Node.js 18+
- You are already signed in to Codex / ChatGPT on this machine
- Default auth file path: `$CODEX_HOME/auth.json` when `CODEX_HOME` is set; otherwise `~/.codex/auth.json`

You can verify the auth file exists:

```bash
ls ~/.codex/auth.json
```

### 2. Run with npx

```bash
npx @thkdog/codex-openai-proxy
```

Default listen address:

```text
http://127.0.0.1:8787
```

If you are developing inside this repository, you can also run:

```bash
npm install
npm run dev
```

On startup, the server prints:

- service URL
- active auth file path
- health check URL
- models URL
- OpenAI SDK `baseURL`
- copy-paste `curl` commands for verification

## CLI Options

This project uses command-line arguments for server configuration. It reads `CODEX_HOME` only to locate Codex's default `auth.json`; `--auth-file` takes precedence.

Show help:

```bash
npx @thkdog/codex-openai-proxy --help
```

Available options:

- `-H, --host <host>`: listen host, default `127.0.0.1`
- `-p, --port <port>`: listen port, default `8787`
- `-a, --auth-file <path>`: auth file path, default `$CODEX_HOME/auth.json` when set, otherwise `~/.codex/auth.json`

Examples:

```bash
npx @thkdog/codex-openai-proxy --port 9000
```

```bash
npx @thkdog/codex-openai-proxy --host 0.0.0.0 --port 9000
```

```bash
npx @thkdog/codex-openai-proxy --auth-file ~/.codex/auth.json
```

```bash
npx @thkdog/codex-openai-proxy --host 0.0.0.0 --port 9000 --auth-file ~/.codex/auth.json
```

You can also install it globally:

```bash
npm install -g @thkdog/codex-openai-proxy
codex-openai-proxy --port 9000
```

## Verify

Health check:

```bash
curl http://127.0.0.1:8787/health
```

List models:

```bash
curl http://127.0.0.1:8787/v1/models
```

The response includes the published GPT-6 IDs (`gpt-6-astra`, `gpt-6.1-sol`,
`gpt-6-luna`, and the earlier `gpt-6-sol`) alongside the Codex model catalog.
Listing an ID does not guarantee that the connected Codex account can use it.

Root info page:

```bash
curl http://127.0.0.1:8787/
```

## curl Examples

Non-streaming `chat/completions`:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5-codex",
    "messages": [
      { "role": "user", "content": "Reply with exactly ok" }
    ]
  }'
```

Streaming `chat/completions`:

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5-codex",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Reply with exactly ok" }
    ]
  }'
```

Non-streaming `responses`:

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5-codex",
    "input": [
      {
        "type": "message",
        "role": "user",
        "content": [
          { "type": "input_text", "text": "Reply with exactly ok" }
        ]
      }
    ]
  }'
```

## OpenAI SDK Example

Install the official SDK first:

```bash
npm install openai
```

`chat/completions` example:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "dummy",
  baseURL: "http://127.0.0.1:8787/v1",
});

const result = await client.chat.completions.create({
  model: "gpt-5-codex",
  messages: [
    { role: "user", content: "Reply with exactly ok" },
  ],
});

console.log(result.choices[0]?.message?.content);
```

`responses` example:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "dummy",
  baseURL: "http://127.0.0.1:8787/v1",
});

const result = await client.responses.create({
  model: "gpt-5-codex",
  input: "Reply with exactly ok",
});

console.log(result.output_text);
```

## Troubleshooting

Auth file not found:

- the default path is not `~/.codex/auth.json`
- pass `--auth-file` explicitly
- `--auth-file ~/.codex/auth.json` is supported and `~` will be expanded automatically

Invalid auth file:

- the file is not valid JSON
- or it is missing `tokens.access_token`
- or it is missing `tokens.account_id`

Port issues:

- `--port` must be an integer between `1` and `65535`
- or the port is already in use

Expired Codex auth state:

- `/health` works but `/v1/models` fails
- in that case you usually need to sign in to Codex / ChatGPT again so the local auth file is refreshed
