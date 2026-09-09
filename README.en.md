# Karakeep AI Proxy

**Languages / Idiomas / Langues:** [Español](README.md) | [English](README.en.md) | [Français](README.fr.md)

---

A Node.js/TypeScript HTTP proxy sitting between [Karakeep](https://github.com/karakeep-app/karakeep) and multiple inference providers — **Groq**, **Gemini**, **OpenRouter**, **Cloudflare**, and **Ollama** — to process a massive backlog of bookmarks without rate limits causing jobs to fail in BullMQ.

## What does it do?

- Exposes a single OpenAI-compatible endpoint at `http://ai-proxy:8080/v1`
- Applies **automatic failover**: Groq → Gemini → wait (queue) during the day
- At night, automatically routes to **local Ollama** without manual intervention
- Applies **2-level taxonomy enrichment and tag stance neutrality**: intercepts Karakeep tagging requests and injects the canonical tag list, enforcing a strict quota of 5 tags (2 general tags from the canonical list + 3 specific topic tags) while ensuring tags reflect the actual stance or critique of the text (anti-nominal bias)
- Tracks RPM/TPM/TPD per provider and triggers **proactive** failover at 80% of the quota limit (before an actual 429 error occurs)
- If a real 429 occurs, treats the provider as exhausted and performs instant failover
- Requests that cannot be processed immediately are **queued** (never rejected with 5xx) so Karakeep's BullMQ does not mark them as failed
- The queue is persistent on disk (can be restarted without losing jobs)

## State Flow

```
[Groq active]
   │ RPM/TPM/TPD ≥ 80% of limit ──→ [Gemini active]
   │ Actual 429 from Groq       ──→ [Gemini active]
   │
[Gemini active]
   │ RPM/TPM/TPD ≥ 80% of limit ──→ [Waiting / queue]
   │ Actual 429 from Gemini     ──→ [Waiting / queue]
   │
[Waiting / queue]
   │ Groq or Gemini regains quota ──→ [returns to best provider]
   │ ACTIVE_HOURS_END reached     ──→ [Ollama active]
   │
[Ollama active]  ← night, unlimited quota
   │ ACTIVE_HOURS_START reached   ──→ [Groq active] (counter reset)
```

## Installation and Configuration

### 1. Configure the proxy

```bash
cd ai-proxy
cp .env.example .env
# Edit .env with your real API keys
nano .env
```

Minimum variables to configure:

| Variable | Where to get it |
|---|---|
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) |
| `GEMINI_API_KEY` | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |
| `TIMEZONE` | Your timezone ([list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)) |

### 2. Activate the proxy in Karakeep

```bash
cd karakeep
make use-proxy
```

This copies `.env.proxy` → `.env` (which sets `OPENAI_BASE_URL=http://ai-proxy:8080/v1`) and restarts the Karakeep worker.

### 3. Start the entire stack

```bash
cd karakeep
docker compose up -d
```

The `ai-proxy` service is built automatically from `../ai-proxy/Dockerfile`.

### 4. Verify it is working

```bash
# Proxy status (active provider, quota, queue size)
make proxy-status

# Or directly via curl
curl http://localhost:8081/status | python3 -m json.tool

# Real-time proxy logs
make proxy-logs
```

## Stopping the Service

### Stop everything (free up RAM and CPU)

```bash
cd ~/Web/karakeep/karakeep
docker compose down
```

Stops and removes all containers. Persistent data (bookmarks, proxy queue) remains intact in Docker volumes.

### Starting it back up

```bash
docker compose up -d
```

> `--build` is not needed unless you modified proxy code.

### Stop only the proxy (keep Karakeep running)

If you need to free up resources while keeping Karakeep running, you can stop just the proxy and point Karakeep directly to a provider:

```bash
docker compose stop ai-proxy
make use-groq    # or use-gemini / use-ollama
```

To resume using the proxy later:

```bash
docker compose start ai-proxy
make use-proxy
```

## Suggested Limits (Free Tier) — Verify in Each Dashboard

> ⚠️ These values are estimates. Actual limits vary depending on plan and model. **Verify them in your dashboard before using in production.**

| Provider | Model | RPM | TPM | TPD | ~bookmarks/day |
|---|---|---|---|---|---|
| Groq | `openai/gpt-oss-20b` | 30 | 14,400 | 200,000 | ~80 |
| Gemini | `gemini-3.5-flash` | 15 | 1,000,000 | unlimited | ~400+ |
| Ollama | `qwen2.5:7b` | ∞ | ∞ | ∞ | ∞ |

- Groq: [console.groq.com/settings/limits](https://console.groq.com/settings/limits)
- Gemini: [ai.google.dev/gemini-api/docs/rate-limits](https://ai.google.dev/gemini-api/docs/rate-limits)

## Coordination with Ollama

The proxy automatically detects when the current time is outside the `ACTIVE_HOURS_START–ACTIVE_HOURS_END` window and routes requests to Ollama. No cron job or `make use-ollama` is required.

If you want to bypass the proxy completely (emergency, debugging):

```bash
make use-ollama   # Karakeep points directly to Ollama, bypassing the proxy
make use-proxy    # Switches back to using the proxy
```

## Tag and Taxonomy Enrichment (`tagEnricher`)

The proxy transparently intercepts Karakeep's automatic tagging requests (`/v1/chat/completions`) and injects the master canonical tag list (`canonical_tags.json`) along with precise categorization and thematic framing instructions.

### Tagging System Features:

1. **Mandatory 2-tier structure with fixed quotas (exactly 5 tags)**:
   - **General Level (exactly 2 tags)**: Broad concepts taken from the pre-existing canonical list (`canonical_tags.json`, ~800 tags). Used for cataloging and global search (e.g., `marxismo`, `economia`, `cine`).
   - **Specific Level (exactly 3 tags)**: Steps down one conceptual level from the general tier, naming the specific sub-topic, case study, author, country, event, or concrete mechanism analyzed in the text (e.g., if the general level is `marxismo`, the specific level could be `teoria-del-valor`, `debate-partido-sindicato`, or `acumulacion-por-desposesion`).
   - The fixed quota (2 + 3 = 5) prevents small models (such as those on Groq, Gemini Flash, or Llama on Cloudflare) from taking the path of least resistance and returning only broad umbrella categories.

2. **Resolution of contradiction in the specificity rule**:
   - The LLM is explicitly instructed that the existence of a broad concept in the master list **only exempts it from inventing a redundant general tag**, but **never exempts it from generating the 3 specific level-2 tags**. This prevents normalization rules from suppressing detailed tagging.

3. **Stance neutrality and anti-nominal bias (*Stance Neutrality*)**:
   - Each tag reflects what the article actually **argues**, counteracting the common statistical bias in LLMs where a nominal or "neutral" concept name is assigned to texts that fundamentally critique it.
   - If an article criticizes, refutes, or challenges a concept (e.g., philanthropy, free market, meritocracy), the tag must capture that critique — using an established term (e.g., `filantrocapitalismo`) or a descriptive one (e.g., `critica-meritocracia`, `precarizacion-laboral`) — rather than using the affirmative or neutral name (`filantropia`), which would misleadingly imply favorable coverage.

4. **Strict normalization (`kebab-case`)**:
   - All tags are enforced to lowercase words separated by hyphens, with no spaces or special characters (`#`, `'`, `"`).
   - `sanitizeTaggingResponse()` in the proxy programmatically validates and sanitizes the model's JSON response before passing it to Karakeep, ensuring complete database consistency.

5. **Full canonical list injection with hot reload**:
   - Maintains coverage and consistency across the global taxonomy by injecting the ~800 canonical tags into every request.
   - The file is cached in memory and checks its modification timestamp (`mtime`) every 10 seconds, reloading automatically when modified without requiring a container restart.

## Project Structure

```
ai-proxy/
├── src/
│   ├── config.ts                    # Reads and validates environment variables
│   ├── logger.ts                    # Level-based logger
│   ├── index.ts                     # Entry point, Express server, graceful shutdown
│   ├── providers/
│   │   ├── types.ts                 # Interfaces and enums
│   │   ├── rateLimiter.ts           # Sliding-window RPM/TPM + daily TPD
│   │   └── providerManager.ts       # State machine for Groq/Gemini/Ollama
│   ├── proxy/
│   │   ├── forwardRequest.ts        # HTTP forwarding + model rewriting
│   │   ├── handler.ts               # Express handler + queue drainer
│   │   └── tagEnricher.ts           # Interceptor and canonical tag injector
│   ├── queue/
│   │   └── requestQueue.ts          # FIFO queue with JSON disk persistence
│   ├── routes/
│   │   └── status.ts                # GET /status + GET /health
│   └── tests/
│       ├── rateLimiter.test.ts
│       ├── activeHours.test.ts
│       ├── providerManager.test.ts
│       └── tagEnricher.test.ts
├── .env.example
├── Dockerfile
├── package.json
└── tsconfig.json
```

## Local Development (without Docker)

```bash
cd ai-proxy
pnpm install
cp .env.example .env
# Edit .env
pnpm run build
node dist/index.js
```

## Tests

```bash
cd ai-proxy
pnpm test
```
