# Karakeep AI Proxy

[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev/)
[![Docker](https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white)](#option-b--standalone-with-docker)

**Languages / Idiomas / Langues:** [Español](README.md) | [English](README.en.md) | [Français](README.fr.md)

---

An OpenAI-compatible HTTP proxy built with Node.js/TypeScript that sits between [Karakeep](https://github.com/karakeep-app/karakeep) and multiple LLM inference providers (**Groq**, **Gemini**, **OpenRouter**, **Cloudflare Workers AI**, and **Ollama**) to process a massive backlog of bookmarks using **free tiers only**, without rate limits causing jobs to fail.

## 🧩 The Problem It Solves

Karakeep uses an LLM to tag and summarize every bookmark you save. If your backlog is large (thousands of articles), any single provider's free tier is exhausted within minutes, and Karakeep starts marking jobs as failed in BullMQ. This proxy acts as an intermediary layer that:

- Distributes load across **multiple free providers in a cascading sequence**, proactively switching to the next provider *before* hitting the actual rate limit (rather than waiting for a 429 error).
- **Queues** requests that cannot be processed immediately instead of rejecting them, ensuring Karakeep never encounters an error.
- At night, when human traffic is low, automatically routes requests to a **local model (Ollama)** with no quota restrictions.
- Optionally intercepts tagging requests to inject a custom canonical tag taxonomy with consistency rules (see [Tag and Taxonomy Enrichment](#-tag-and-taxonomy-enrichment-tagenricher)).

## 📑 Table of Contents

- [What It Does](#-what-it-does)
- [Architecture / State Flow](#-architecture--state-flow)
- [Requirements](#-requirements)
- [Installation](#-installation)
  - [As a container alongside Karakeep (Intended Use)](#option-a--as-a-container-alongside-karakeep-intended-use)
  - [Standalone with Docker](#option-b--standalone-with-docker)
  - [Local development without Docker](#option-c--local-development-without-docker)
- [Configuration (Environment Variables)](#-configuration-environment-variables)
- [Endpoints](#-endpoints)
- [Tag and Taxonomy Enrichment](#-tag-and-taxonomy-enrichment-tagenricher)
- [Project Structure](#-project-structure)
- [Tests](#-tests)
- [Free Tier Limits](#-suggested-limits-free-tier--verify-in-each-dashboard)
- [Troubleshooting](#-troubleshooting)
- [License](#-license)

## ✅ What It Does

- Exposes a single OpenAI-compatible endpoint at `http://ai-proxy:8080/v1`, designed to be configured as `OPENAI_BASE_URL` in Karakeep (or any client compatible with the OpenAI API).
- Applies **automatic cascading failover** across providers: `Groq → Gemini → OpenRouter → Cloudflare → queue`, configurable via `PROVIDER_ORDER`.
- At night (outside the `ACTIVE_HOURS_START`–`ACTIVE_HOURS_END` window), automatically routes to **local Ollama** without manual intervention.
- Tracks RPM/TPM/TPD/RPD per provider using sliding windows and triggers **proactive** failover upon reaching `EXHAUSTION_THRESHOLD` (80% by default) — before receiving a real 429.
- If a real 429 occurs anyway, interprets it as "provider exhausted" and fails over instantly.
- Requests that cannot be processed immediately are **queued** (never rejected with a 5xx response) so BullMQ does not mark them as failed.
- The queue is persistent on disk (`QUEUE_PERSIST_PATH`), surviving container restarts.
- Exposes `GET /status` and `GET /health` for observability.
- Optionally **enriches Karakeep tagging requests** with a custom tag taxonomy (see below).

## 🔀 Architecture / State Flow

At a high level, it operates as a simple cascade: `Groq → Gemini → OpenRouter → Cloudflare → queue`, and outside active operating hours (`ACTIVE_HOURS_START`–`ACTIVE_HOURS_END`), everything routes to local Ollama. The order is configured via `PROVIDER_ORDER`.

The non-trivial mechanics lie in the details of each transition:

- **Sliding-window rate limiting instead of fixed counters**: each provider tracks 4 metrics in parallel (RPM, TPM, TPD, RPD) with independent sliding windows. A naive counter that resets every minute allows double bursts across window boundaries; a sliding window prevents this.
- **Proactive failover, not just reactive**: the proxy switches providers upon reaching `EXHAUSTION_THRESHOLD` (80% by default) of the most restrictive of the 4 metrics, *before* the provider responds with a 429. If a real 429 occurs nonetheless, it is treated as an explicit exhaustion signal.
- **Atomic disk-persisted queue, not in-memory**: requests that cannot be handled immediately are written to `QUEUE_PERSIST_PATH` instead of being lost. Each write goes to a temporary file first and is then renamed over the final target (`rename` is atomic in POSIX), so a crash midway through writing leaves the previous file intact instead of producing truncated JSON.
- **Graceful shutdown with timeout**: upon receiving `SIGTERM`/`SIGINT`, it stops accepting new connections, flushes the queue to disk, and allows up to 30s before forcing exit — preventing interrupted writes.
- **Hot-reloading tag taxonomy**: `canonical_tags.json` is cached in memory with its `mtime` checked every 10s, allowing you to edit the tag list without restarting the proxy.

This behavior is covered by tests in `src/tests/` (`rateLimiter.test.ts`, `activeHours.test.ts`, `providerManager.test.ts`, `tagEnricher.test.ts`, `handler.test.ts`), which illustrate the real runtime behavior better than any diagram.

## 📋 Requirements

- Node.js ≥ 20
- [pnpm](https://pnpm.io/) (the repo uses `pnpm-lock.yaml`)
- Docker and Docker Compose (optional, recommended for production)
- At least one API key from a supported provider ([see limits table](#-suggested-limits-free-tier--verify-in-each-dashboard))

## 🚀 Installation

### Option A — As a container alongside Karakeep (Intended Use)

This proxy is designed to run as an additional service inside Karakeep's `docker-compose.yml`, pointing `OPENAI_BASE_URL` toward it.

**1. Configure the proxy**

```bash
cd ai-proxy
cp .env.example .env
nano .env   # fill in your real API keys
```

**2. Add the service to Karakeep's `docker-compose.yml`**

```yaml
services:
  ai-proxy:
    build: ../ai-proxy
    env_file: ../ai-proxy/.env
    ports:
      - "8081:8080"
    restart: unless-stopped

  karakeep_worker:
    environment:
      - OPENAI_BASE_URL=http://ai-proxy:8080/v1
```

**3. Start the stack**

```bash
docker compose up -d
```

**4. Verify it is working**

```bash
curl http://localhost:8081/status | python3 -m json.tool
docker compose logs -f ai-proxy
```

> Service names, ports, and the mechanism to repoint `OPENAI_BASE_URL` depend on how your own Karakeep `docker-compose.yml` is set up — the snippet above is a starting point, not a rigid contract.

### Option B — Standalone with Docker

To test the proxy on its own, without Karakeep:

```bash
cd ai-proxy
cp .env.example .env
# Edit .env with your API keys

docker build -t ai-proxy .
docker run -d --name ai-proxy \
  --env-file .env \
  -p 8080:8080 \
  -v $(pwd)/data:/app/data \
  ai-proxy
```

### Option C — Local Development (without Docker)

```bash
cd ai-proxy
pnpm install
cp .env.example .env
# Edit .env
pnpm run build
node dist/index.js

# or in watch mode:
pnpm run dev
```

## ⚙️ Configuration (Environment Variables)

All variables are documented with their default values in [`.env.example`](./.env.example). Summary by provider:

| Provider | Key Variables | Required |
|---|---|---|
| **Groq** | `GROQ_API_KEY`, `GROQ_MODEL`, `GROQ_RATE_LIMIT_{RPM,TPM,TPD,RPD}` | Yes |
| **Gemini** | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_RATE_LIMIT_{RPM,TPM,TPD,RPD}` | Yes |
| **OpenRouter** | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_RATE_LIMIT_{RPM,RPD}` | Yes |
| **Cloudflare Workers AI** | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_MODEL`, `CLOUDFLARE_RATE_LIMIT_{RPM,TPD}` | Yes |
| **Ollama** (local) | `ENABLE_OLLAMA`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | No (default `true`, requires running Ollama) |

> Each provider's API key is only required if that provider is listed in `PROVIDER_ORDER`. If, for example, you only want to use Groq and Gemini, you can leave `OPENROUTER_API_KEY` / `CLOUDFLARE_API_TOKEN` empty and remove them from `PROVIDER_ORDER` — the process will start normally.

General proxy variables:

| Variable | Default | Description |
|---|---|---|
| `PROXY_PORT` | `8080` | HTTP server port |
| `PROVIDER_ORDER` | `groq,gemini,openrouter,cloudflare` | Failover cascade order |
| `EXHAUSTION_THRESHOLD` | `0.80` | % of limit at which a provider is considered "exhausted" (proactive failover) |
| `WAIT_MAX_MS` | `20000` | Max time (ms) connection is held open before enqueuing |
| `QUEUE_PERSIST_PATH` | — | Path to persist the queue across restarts (e.g. `/app/data/queue.json`) |
| `MAX_BODY_BYTES` | `5000000` | Maximum incoming request body size; exceeding this returns `413` |
| `REQUEST_READ_TIMEOUT_MS` | `30000` | Max time to finish reading incoming body; exceeding this returns `408` |
| `ACTIVE_HOURS_START` / `ACTIVE_HOURS_END` | `07:00` / `22:00` | Time window during which cloud cascade is used; outside it, Ollama is used |
| `TIMEZONE` | `America/Argentina/Buenos_Aires` | Timezone used to calculate `ACTIVE_HOURS_*` |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `CANONICAL_TAGS_PATH` | `./data/canonical_tags.json` | Path to canonical tags file for `tagEnricher` (optional) |

**Where to get each API key:**

| Provider | Where to get it |
|---|---|
| Groq | [console.groq.com/keys](https://console.groq.com/keys) |
| Gemini | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) |
| Cloudflare Workers AI | [dash.cloudflare.com](https://dash.cloudflare.com/) → *Manage Account → Tokens* (*Workers AI* scope) + Account ID in *Account Overview* |

## 🔌 Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/*` | OpenAI-compatible endpoint; forwards to the active provider according to state machine |
| `GET` | `/status` | Current status: active provider, quota usage per provider, queue size |
| `GET` | `/health` | Simple health check (`{ ok: true }`) |

Example of `GET /status`:

```json
{
  "activeProvider": "GROQ",
  "activeHours": true,
  "providers": {
    "groq":       { "exhausted": false, "rpm": { "used": 4, "limit": 30, "pct": 0.13 } },
    "gemini":     { "exhausted": false, "rpm": { "used": 0, "limit": 15, "pct": 0 } },
    "openrouter": { "exhausted": false, "rpm": { "used": 0, "limit": 20, "pct": 0 } },
    "cloudflare": { "exhausted": false, "rpm": { "used": 0, "limit": 300, "pct": 0 } },
    "ollama":     { "active": false }
  },
  "queueSize": 0,
  "timestamp": "2026-09-09T12:00:00.000Z"
}
```

## 🏷️ Tag and Taxonomy Enrichment (`tagEnricher`)

This is an **optional** module designed for custom workflows (a reading backlog with a hand-curated tag taxonomy); if not interested, simply omit `CANONICAL_TAGS_PATH` / `canonical_tags.json` and the proxy continues operating as a pure failover proxy.

When active, the proxy transparently intercepts Karakeep's automatic tagging requests (`/v1/chat/completions`) and injects the master canonical tag list along with categorization directives:

1. **Mandatory 2-tier structure with fixed quotas (exactly 5 tags)**
   - **General level (2 tags)**: broad concepts taken from the pre-existing canonical list (e.g., `marxismo`, `economia`, `cine`), for cataloging and global search.
   - **Specific level (3 tags)**: one step more concrete — sub-topic, case study, author, country, event, or concrete mechanism in the text (e.g., if general is `marxismo`, specific could be `teoria-del-valor` or `acumulacion-por-desposesion`).
   - The fixed quota (2 + 3 = 5) prevents small models (Groq/Gemini Flash/Llama on Cloudflare) from taking the easy path and returning only umbrella categories.

2. **Resolution of the "normalize vs. detail" contradiction**: the fact that a broad concept already exists in the master list only exempts the model from inventing a redundant general tag — it never exempts it from generating the 3 specific level-2 tags.

3. **Stance neutrality / anti-nominal bias**: each tag reflects what the article actually *argues*, counteracting the typical statistical bias of LLMs where a nominal or "neutral" concept name is assigned to texts that critique it. If an article criticizes a concept (e.g., philanthropy, free market, meritocracy), the tag must capture that critique (`filantrocapitalismo`, `critica-meritocracia`) rather than using the affirmative term (`filantropia`).

4. **Strict normalization (`kebab-case`) and quota validation**: all tags are enforced to lowercase words separated by hyphens, with no spaces or special characters. `sanitizeTaggingResponse()` also counts returned tags: if the model ignored the rule of 5 and returned too many, it truncates them; if it returned too few, it allows them through while emitting a warning log — it cannot reconstruct tags the model never generated, but at least it makes it visible in the logs that the model failed to respect the quota.

5. **Hot reload**: the canonical tags file is cached in memory and its `mtime` is checked every 10 seconds, reloading only if changed — without restarting the container.

## 🗂️ Project Structure

```
ai-proxy/
├── src/
│   ├── config.ts                    # Reads and validates env vars
│   ├── logger.ts                    # Logger with levels
│   ├── index.ts                     # Entry point, Express, graceful shutdown
│   ├── providers/
│   │   ├── types.ts                 # Interfaces and enums
│   │   ├── rateLimiter.ts           # Sliding window RPM/TPM + daily TPD/RPD
│   │   └── providerManager.ts       # State machine for Groq/Gemini/OpenRouter/Cloudflare/Ollama
│   ├── proxy/
│   │   ├── forwardRequest.ts        # HTTP forwarding + model rewriting
│   │   ├── handler.ts               # Express handler + queue drainer
│   │   └── tagEnricher.ts           # Canonical tag interceptor and injector (optional)
│   ├── queue/
│   │   └── requestQueue.ts          # FIFO queue with disk persistence
│   ├── routes/
│   │   └── status.ts                # GET /status + GET /health
│   ├── scripts/
│   │   └── manualTagTest.ts         # Manual test script for tagEnricher
│   └── tests/
│       ├── rateLimiter.test.ts
│       ├── activeHours.test.ts
│       ├── providerManager.test.ts
│       ├── tagEnricher.test.ts
│       └── handler.test.ts          # Integration: failover, queue, body limits
├── .env.example
├── Dockerfile
├── package.json
└── tsconfig.json
```

## 🧪 Tests

```bash
cd ai-proxy
pnpm test          # single run
pnpm test:watch    # watch mode
```

They cover rate limiting logic (sliding window RPM/TPM/TPD), active hours calculation, the `ProviderManager` state machine, tag sanitization in `tagEnricher`, and, in `handler.test.ts`, the end-to-end handler flow (failover between providers by mocking `forwardRequest`, queuing when no provider is available, and rejection of oversized request bodies).

## 📊 Suggested Limits (Free Tier) — Verify in Each Dashboard

> ⚠️ These values are estimates and vary depending on plan and model. **Verify them in your own dashboard before using in production.**

| Provider | Example Model | RPM | TPM | TPD | Cost |
|---|---|---|---|---|---|
| Groq | `openai/gpt-oss-20b` | 30 | 14,400 | 200,000 | Free |
| Gemini | `gemini-flash-lite-latest` | 15 | 1,000,000 | unlimited | Free |
| OpenRouter | `:free` models | 20 | — | credit-based | Free |
| Cloudflare Workers AI | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 300 | — | 10,000 neurons/day | Free |
| Ollama | `qwen2.5:7b` (local) | ∞ | ∞ | ∞ | Free (your hardware) |

- Groq: [console.groq.com/settings/limits](https://console.groq.com/settings/limits)
- Gemini: [ai.google.dev/gemini-api/docs/rate-limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- OpenRouter: `curl https://openrouter.ai/api/v1/auth/key -H "Authorization: Bearer $OPENROUTER_API_KEY"`
- Cloudflare: [developers.cloudflare.com/workers-ai](https://developers.cloudflare.com/workers-ai/platform/pricing/)

## 🛠️ Troubleshooting

| Symptom | Probable Cause | Solution |
|---|---|---|
| Process does not start / `Missing required env var` | Missing API key for a provider that is listed in `PROVIDER_ORDER` | Provide that key in `.env`, or remove that provider from `PROVIDER_ORDER` if you are not using it |
| `413 Payload too large` | Request body exceeds `MAX_BODY_BYTES` | Increase the limit in `.env` if your requests are legitimately larger |
| `408 Request body read timeout` | Client did not finish sending body within `REQUEST_READ_TIMEOUT_MS` | Check network connection between Karakeep and the proxy; increase the timeout if your network is slow |
| All requests are queued and never resolve | All cloud providers exhausted and `ENABLE_OLLAMA=false` (or Ollama unreachable) | Enable Ollama or wait for the daily quota reset |
| `ECONNREFUSED` against Ollama | `OLLAMA_BASE_URL` points to `localhost` from inside a container | Use `http://host.docker.internal:11434/v1` (or the service hostname on your Docker network) |
| Karakeep still connects directly to provider | `OPENAI_BASE_URL` does not point to proxy | Verify that the Karakeep worker has `OPENAI_BASE_URL=http://ai-proxy:8080/v1` |
| Tags do not adhere to the 5-tag quota | `tagEnricher` disabled or `canonical_tags.json` missing | Verify `CANONICAL_TAGS_PATH` and ensure the file exists and is valid JSON |

## 📄 License

This repository does not yet include a `LICENSE` file. If you plan to share it publicly, consider adding one (for example [MIT](https://choosealicense.com/licenses/mit/)) to clarify what others can do with the code.
