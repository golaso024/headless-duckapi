<p align="center"><img src="assets/banner.svg" alt="headless-duckapi" width="100%"></p>

<h1 align="center">headless-duckapi</h1>

<p align="center"><b>A Telegram bot and an OpenAI-compatible API on DuckDuckGo's free duck.ai models.<br>
Streaming answers · GPT / Claude / Mistral · image generation · photo vision · no API keys</b></p>

<p align="center">
  <a href="README.ru.md">🇷🇺 README на русском</a>&nbsp;·&nbsp;
  <a href="serverless/README.md">☁️ Telegram Serverless variant</a>&nbsp;·&nbsp;
  <a href="LICENSE">MIT</a>
</p>

> **headless-duckapi** turns the [duck.ai](https://duck.ai) chat (the one DuckDuckGo ships for free, no API key, no account) into a full-featured Telegram bot. It includes a **pure-JavaScript implementation of the duck.ai protocol** — including the antibot challenge solver that runs the obfuscated JS in a hand-built browser mock. No OpenAI keys, no VPS GPU, nothing to pay for.

---

## What you get

| | |
|---|---|
| 💬 **Streaming chat** | Answers are edited into one message live, token by token (Telegram-safe edit throttling, rollover for long texts) |
| 🤖 **Models** | GPT-5.4 mini, GPT-6 Luna, Claude Haiku 4.5, Mistral Small, GPT-OSS 120B, Gemma 4… — the list is fetched live from duck.ai with a static fallback |
| 🎨 **`/img` image generation** | duck.ai's GenerateImage tool: draft preview while it renders, then the final image as a photo, per-user daily quota |
| 📸 **Photo vision** | Send a photo (JPEG auto-re-encoded to PNG), ask about it |
| 🌐 **Web search toggle** | duck.ai's WebSearch tool, per-chat |
| 🧠 **Reasoning effort** | none / low / medium, per-chat |
| ⚙️ **Mini App** | Telegram-styled settings web app (models, effort, search, history reset) served by the bot itself |
| 📊 **/stats** | Users, sources (incl. deep-link refs and groups), daily activity, model top, duck.ai protocol health |
| 💾 **Memory** | Per-chat conversation history in SQLite, auto-pruned |
| 🦆 **Antibot-hardened** | Challenge tokens, frontend versions and solved proofs are cached in the DB to stay far away from duck.ai's 418/429 |

**Bot commands:** `/start` `/help` `/img` `/models` `/model` `/effort` `/web` `/reset` `/settings` `/stats` — plus a persistent reply-keyboard menu. On first boot the bot configures its own description, command list, menu button and avatar.

## Architecture

```
                        Telegram                       duck.ai
                 (Bot API, long polling)         (undocumented chat API)
                          │                              │
                 ┌────────▼─────────┐          ┌─────────▼──────────┐
                 │      app.js      │          │ bot/lib/duckai.js  │
                 │  polling loop    │          │  protocol client   │
                 │  HTTP (mini app) │          │  challenge solver  │
                 ├──────────────────┤          │  (pure JS, no deps)│
                 │ bot/handlers/*   │◄────────►│  SSE streaming     │
                 │ cloud code,      │  'sdk'   └────────────────────┘
                 │ 2 marked patches │  compat
                 ├──────────────────┤  layer
                 │ platform/sdk/    │
                 │  api → Bot API   │
                 │  db  → SQLite    │
                 │  fetch → Node    │
                 └──────────────────┘
```

- **`bot/`** — the actual bot logic. It runs **unchanged** on both Telegram's Serverless cloud (see [`serverless/`](serverless/README.md)) and any VPS; only two lines are patched for VPS life (marked `[VPS port patch]`).
- **`platform/sdk/`** — a thin compatibility layer that implements the cloud platform's `sdk` module for Node.js: `api` → Bot API over HTTPS (with multipart file uploads), `db` → SQLite via the built-in `node:sqlite`, `fetch` → global fetch. This is what makes the same code run in both places.
- **`web/`** — the Mini App frontend. It already speaks both transports: the platform's `Serverless.call` in the cloud, and plain `POST /api/settings` with a signed `initData` header when self-hosted.
- **`api.js`** — an optional Telegram-free entrypoint: the same `bot/lib/duckai.js` protocol client behind an OpenAI-compatible HTTP server (`/v1/chat/completions`, `/v1/models`, `/health`). No `BOT_TOKEN`, no DB — see [OpenAI-compatible API](#openai-compatible-api-no-telegram-token-needed).

## Quick start (Docker)

```bash
git clone https://github.com/<your-username>/headless-duckapi.git && cd headless-duckapi
cp .env.example .env          # then put your bot token into .env
docker compose up -d --build
```

That's it — open the bot in Telegram and send `/start`. Logs: `docker compose logs -f`.

Don't want to clone and build? There's a prebuilt image (GitHub Actions builds it on every `v*` tag):

```bash
# API mode, no Telegram token:
docker run -d -p 8081:8080 -e API_KEY=secret ghcr.io/golaso024/headless-duckapi:latest node api.js
# or the bot:
docker run -d -e BOT_TOKEN=123:ABC ghcr.io/golaso024/headless-duckapi:latest
```

## Quick start (native)

Node.js **≥ 22.5** (24 recommended — SQLite is built in, so `npm install` brings zero dependencies):

```bash
git clone https://github.com/golaso024/headless-duckapi.git && cd headless-duckapi
npm install
cp .env.example .env          # then put your bot token into .env
node app.js
```

To keep it running like a service:

```bash
sudo cp systemd/duckai.service /etc/systemd/system/
# edit User=/WorkingDirectory=/EnvironmentFile= paths inside to match your install
sudo systemctl daemon-reload && sudo systemctl enable --now duckai
journalctl -u duckai -f
```

> Get the token from **@BotFather → your bot → API Token**. Use a bot token of a bot you control; don't run this and the Serverless copy on the same token at the same time (the VPS build removes the webhook on boot — last one started wins).

## OpenAI-compatible API (no Telegram token needed)

Since v1.1.0 the same pure-JS duck.ai protocol is also exposed as an **OpenAI-compatible HTTP API** — zero Telegram dependencies: no `BOT_TOKEN`, no `.env`, no SQLite (challenge tokens are cached in process memory). Same challenge solver, same streaming, same models — just `POST /v1/chat/completions`:

```bash
# Docker — API only:
docker compose --profile api up -d --build headless-duckapi-api
# → http://localhost:8081/v1/chat/completions

# Native:
node api.js                   # or: PORT=8080 API_KEY=secret node api.js
node api.js models            # print the live model list and exit
```

Try it:

```bash
curl http://localhost:8081/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.4-mini","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

| Endpoint | Description |
|---|---|
| `GET /v1/models` | Live model list from duck.ai (static fallback if duck.ai is unreachable) |
| `POST /v1/chat/completions` | Chat completion, `stream: true/false` — SSE chunks in the OpenAI format |
| `GET /health` | Liveness probe (also used by the Docker healthcheck) |

OpenAI client compatibility (`baseURL = http://localhost:8081/v1`, any `apiKey` unless `API_KEY` is set):

- stale model ids (`gpt-4o-mini`, `claude-3-haiku`, …) resolve to the closest current duck.ai model — `GET /v1/models` is the source of truth;
- `content` may be an array of parts: `{type:"text"}` and `{type:"image_url"}` (data: or http(s) URLs; JPEG is re-encoded to PNG in pure JS — duck.ai rejects JPEG parts);
- `role: "developer"` maps to `system`;
- `temperature`, `max_tokens` and friends are accepted and ignored — duck.ai has no such knobs.

Extensions beyond the OpenAI schema, all optional:

| Field | Meaning |
|---|---|
| `reasoning_effort: "none" / "low" / "medium"` | duck.ai reasoning effort (validated against the model, so you get a 400 instead of a duck.ai 400) |
| `web_search: true` | duck.ai WebSearch tool |
| `image: true` | duck.ai GenerateImage tool — the response carries `message.images: ["data:image/…;base64,…"]` (known to work with the GPT models; the bot's default for `/img` is `gpt-6-luna`) |

Set `API_KEY` (in `.env` for the Docker profile — compose picks it up automatically — or in the environment) to require `Authorization: Bearer <API_KEY>`; leave it empty only on a trusted network.

## Configuration (`.env`)

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | ✅ | Bot token from @BotFather |
| `ADMIN_IDS` | — | Comma-separated Telegram user ids allowed to run `/stats`. The original author's id is baked in as a default admin — add yours |
| `WEBAPP_URL` | — | Public `https://` URL of this host for the 🎛 Настройки Mini App button. Telegram only accepts `https` there; if unset the button is hidden and `/settings` still covers everything |
| `PORT` | — | HTTP port for the Mini App/API server (default `8080`) |
| `DATA_DIR` | — | SQLite storage directory (default `./data`) |
| `API_PORT` | — | Host port for the API container (docker compose, `headless-duckapi-api` service; default `8081`) |
| `API_KEY` | — | Bearer token for the API mode (`api.js`): clients send `Authorization: Bearer <API_KEY>`. Empty = open server |

### Mini App over HTTPS (optional)

The bot serves the Mini App itself on `PORT`. Telegram requires an `https://` URL for `web_app` keyboard buttons, so put a TLS proxy in front and set `WEBAPP_URL`:

```bash
# /etc/caddy/Caddyfile — Caddy handles certificates automatically
duck.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Then `WEBAPP_URL=https://duck.example.com` in `.env` and restart. See [`examples/Caddyfile`](examples/Caddyfile).

### Runtime overrides (config table)

Without touching code, via the CLI (or any SQLite client on `data/duck.db`):

```bash
node app.js config set img_enabled true      # /img on/off ('false' kills it)
node app.js config set img_model gpt-6-luna  # image model (default gpt-6-luna)
node app.js config set img_daily_limit 3     # per-user daily /img quota
node app.js config list                      # everything set
node app.js setup                            # re-apply description/commands/avatar
```

## How the duck.ai protocol works

The fun part of this project — [`bot/lib/duckai.js`](bot/lib/duckai.js), ~42 KB of dependency-free JavaScript that reimplements duck.ai's client:

1. `GET /duckchat/v1/status` returns `x-vqd-hash-1`: a base64-encoded **JS challenge**.
2. The challenge is obfuscated JavaScript that fingerprints the browser (DOM parsing, `NodeList`, `window` semantics, timing). headless-duckapi solves it inside a **hand-built browser mock** (`buildBrowserMock`): an HTML5 fragment parser, real tree-walking `querySelector`, a `NodeList` class, `[object Window]` via `Symbol.toStringTag` — verified against four captured challenge flavors. The solved proof is SHA-256-hashed client-side and merged into the expected metadata shape.
3. `GET https://duck.ai/` gives the frontend version (`x-fe-version`), also cached.
4. `POST /duckchat/v1/chat` with the solved token streams the answer as SSE. Tools (web search, image generation) ride on the same stream.

Solved tokens, frontend versions and protocol counters are persisted in SQLite (`config` / `duck_daily` tables), so restarts don't re-bother the challenge endpoint — that's what keeps the bot clear of 418s/429s. Protocol originally ported from [aurora-develop/Duck2api](https://github.com/aurora-develop/Duck2api) (Go), then hardened and extended.


## Troubleshooting

| Symptom | Meaning / fix |
|---|---|
| `getUpdates conflict: another getUpdates/webhook instance is running` | The Serverless copy of this bot is still deployed on the same token. Stop one of them. |
| `Telegram auth failed: Unauthorized` | Wrong `BOT_TOKEN` — re-check @BotFather. |
| 418/429 messages in chat | duck.ai is rate-limiting; the bot retries with fresh tokens automatically. If it persists, wait a few minutes. |
| No 🎛 Настройки button in the menu keyboard | `WEBAPP_URL` is not set to an `https://` URL — see the Mini App section. |
| `headless-duckapi needs SQLite…` at boot | Your Node lacks `node:sqlite` (needs ≥ 22.5; on 22.x run `node --experimental-sqlite app.js`) and `better-sqlite3` failed to install. Upgrade Node or `npm install better-sqlite3`. |
| Bot is silent in groups | By design: privacy mode + group messages are answered on commands only. |

## Running on Telegram Serverless instead

The same bot was originally built for (and still runs on) Telegram's free Serverless platform — no VPS needed at all. The pristine cloud project lives in [`serverless/`](serverless/README.md) with deploy instructions (`tgcloud push && tgcloud migrate --safe`).

## Credits & license

- Protocol basis: [aurora-develop/Duck2api](https://github.com/aurora-develop/Duck2api)
- Built for the Telegram Serverless platform; VPS port, challenge hardening, image generation and metrics
- MIT — see [LICENSE](LICENSE)
