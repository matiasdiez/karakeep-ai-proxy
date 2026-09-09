# 🚀 Karakeep AI Proxy - Provider Setup Guide

## Overview

The Karakeep AI Proxy now supports **5 LLM providers** with intelligent failover:

**Failover Chain:** Groq → Gemini → OpenRouter → Cloudflare → Queue → [Ollama (if enabled)]

All providers are **free tier only**, with proactive quota tracking and automatic failover.

## Supported Providers

| Provider | RPM | TPM | TPD | Daily Reqs | Cost | Setup Time |
|----------|-----|-----|-----|-----------|------|-----------|
| **Groq** | 30 | 14.4K | 200K | 1000 | ✅ Free | ~2 min |
| **Gemini** | 15 | 1M | ∞ | 1500 | ✅ Free | ~3 min |
| **OpenRouter** | 20 | ∞ | ∞ | ∞ | ✅ Free | ~2 min |
| **Cloudflare** | 300 | ∞ | 10K neurons | ∞ | ✅ Free | ~5 min |
| **Ollama** | ∞ | ∞ | ∞ | ∞ | ✅ Free | ~10 min |

## Quick Start

### 1. Copy Example Configuration

```bash
cd karakeep  # Navigate to the docker-compose directory
cp .env.openrouter .env.local
# OR
cp .env.cloudflare .env.local
```

### 2. Using the Provider Switcher Script

```bash
cd karakeep
./switch-provider.sh openrouter   # Switch to OpenRouter
./switch-provider.sh cloudflare   # Switch to Cloudflare  
./switch-provider.sh groq-gemini  # Switch to Groq + Gemini (default)
./switch-provider.sh status       # Check current setup
```

**Note:** All configuration files (`.env*`) and the `switch-provider.sh` script are located in the `/karakeep/` directory (where `docker-compose.yml` lives).

### 2. Get API Credentials

#### **Groq** (Already configured if using existing .env.proxy)
- Sign up: https://console.groq.com/
- API Key: Created in API Keys section
- Model: `mixtral-8x7b-32768` (recommended)

#### **Google Gemini** (Already configured if using existing .env.proxy)
- Sign up: https://makersuite.google.com/
- API Key: Create in "Get API Key" section
- Model: `gemini-1.5-flash` (or `gemini-1.5-pro` for better results)

#### **OpenRouter** (NEW - Credit-based system)
- Sign up: https://openrouter.ai/
- API Key: Create in https://openrouter.ai/keys
- Model: `openai/gpt-3.5-turbo` (or `openai/gpt-4o-mini`)
- Credit balance: Check via `curl https://openrouter.ai/api/v1/auth/key -H "Authorization: Bearer $OPENROUTER_API_KEY"`
- **Note:** Credit-based, no explicit TPM/TPD limits. RPM=20 enforced.

#### **Cloudflare Workers AI** (NEW - 10K neurons/day)
- Sign up: https://dash.cloudflare.com/
- API Token: Create in "Manage Account" → "Tokens" with "Workers AI" scope
- Account ID: Found in "Account Overview" page
- Models available:
  - `@cf/meta/llama-3.1-70b-instruct` (recommended)
  - `@cf/meta/llama-3-70b-instruct`
  - `@cf/mistral/mistral-7b-instruct-v0.1`
  - `@cf/thebloke/neural-chat-7b-v3-2`
- **Note:** 10,000 neurons/day limit (resets UTC 00:00). Quota resets daily.

#### **Ollama** (Optional - Local)
- Install: https://ollama.ai/
- Run: `ollama serve`
- Model: `mistral`, `neural-chat`, etc.
- **Note:** Disabled by default (`ENABLE_OLLAMA=false`)

### 3. Update Configuration

Edit `.env.local` with your credentials:

```bash
# Required (all providers need these first 4)
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=AIzaSy...

# Choose ONE of these:
OPENROUTER_API_KEY=sk-or-...     # OR
CLOUDFLARE_API_TOKEN=v1.0_...
CLOUDFLARE_ACCOUNT_ID=...

# Optional
ENABLE_OLLAMA=false               # Set to 'true' to enable Ollama
```

### 4. Start the Proxy

```bash
npm install
npm run build
npm start

# Or with nodemon (dev mode)
npm run dev
```

Server runs on `http://localhost:8080`

### 5. Test the Setup

```bash
curl -X POST http://localhost:8080/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 100
  }'
```

## Environment Variables Reference

### Common Variables
```bash
PROXY_PORT=8080                        # Server port
EXHAUSTION_THRESHOLD=0.85              # When to mark provider exhausted (0.0-1.0)
WAIT_MAX_MS=30000                      # Max wait time for queue (ms)
QUEUE_PERSIST_PATH=/tmp/karakeep-queue.jsonl  # Queue persistence
```

### Groq (Required)
```bash
GROQ_API_KEY=gsk_...
GROQ_BASE_URL=https://api.groq.com/openai/v1
GROQ_MODEL=mixtral-8x7b-32768
GROQ_RATE_LIMIT_RPM=30
GROQ_RATE_LIMIT_TPM=14400
GROQ_RATE_LIMIT_TPD=200000
GROQ_RATE_LIMIT_RPD=1000
```

### Gemini (Required)
```bash
GEMINI_API_KEY=AIzaSy...
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
GEMINI_MODEL=gemini-1.5-flash
GEMINI_RATE_LIMIT_RPM=15
GEMINI_RATE_LIMIT_TPM=1000000
GEMINI_RATE_LIMIT_TPD=unlimited
GEMINI_RATE_LIMIT_RPD=1500
```

### OpenRouter (Optional)
```bash
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=openai/gpt-3.5-turbo
OPENROUTER_RATE_LIMIT_RPM=20
OPENROUTER_RATE_LIMIT_RPD=unlimited
```

### Cloudflare (Optional)
```bash
CLOUDFLARE_API_TOKEN=v1.0_...
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_BASE_URL=https://api.cloudflare.com/client/v4/accounts
CLOUDFLARE_MODEL=@cf/meta/llama-3.1-70b-instruct
CLOUDFLARE_RATE_LIMIT_RPM=300
CLOUDFLARE_RATE_LIMIT_TPD=10000
```

### Ollama (Optional)
```bash
ENABLE_OLLAMA=false                    # Set to 'true' to enable
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=mistral
```

## Docker Deployment

### Using Docker Compose

```bash
cd karakeep
docker-compose up ai-proxy
```

The Docker Compose file should be configured to pass environment variables:

```yaml
services:
  ai-proxy:
    build: ../ai-proxy
    ports:
      - "8080:8080"
    environment:
      - GROQ_API_KEY=${GROQ_API_KEY}
      - GEMINI_API_KEY=${GEMINI_API_KEY}
      - OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
      - CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN}
      - CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID}
      - ENABLE_OLLAMA=${ENABLE_OLLAMA:-false}
```

## Monitoring & Status

### Check Provider Status

The proxy exposes provider statistics on startup:

```
2025-02-01 10:15:23 [INFO] AI Proxy initialized
  ✓ Groq (RPM: 30/30, TPM: 14400/14400, TPD: 0/200000)
  ✓ Gemini (RPM: 15/15, TPM: 1000000/1000000, TPD: unlimited)
  ✓ OpenRouter (RPM: 20/20, Credit-based)
  ✓ Cloudflare (RPM: 300/300, Neurons: 0/10000)
  ✗ Ollama (disabled)
```

### Monitor Failover Events

Watch logs for failover messages:

```bash
tail -f /var/log/karakeep/ai-proxy.log | grep "FAILOVER\|EXHAUSTED"
```

Examples:
- `[WARN] Groq exhausted (1000/1000 daily requests). Failover to Gemini...`
- `[WARN] OpenRouter 402: insufficient credits. Failover to Cloudflare...`
- `[WARN] Cloudflare exhausted (10000/10000 neurons today). Queuing request...`

## Troubleshooting

### "Provider not configured" Error

**Cause:** Missing API key for provider
**Solution:** Add the API key to `.env.local`

```bash
echo "GROQ_API_KEY=your_key_here" >> .env.local
```

### "All providers exhausted" Error

**Cause:** All free-tier limits reached
**Solution:** 
1. Check limits: `cat logs/ai-proxy.log | grep EXHAUSTED`
2. Wait for daily reset (Groq/Gemini: UTC midnight; Cloudflare: UTC 00:00)
3. Or use Ollama: `ENABLE_OLLAMA=true`

### "Invalid token" Error

**Cause:** Expired or invalid API credential
**Solution:**
1. Verify credentials are correct: `curl -H "Authorization: Bearer $KEY" $BASE_URL/models`
2. Regenerate key on provider platform
3. Update `.env.local`

### Connection Timeout

**Cause:** Proxy can't reach provider API
**Solution:**
1. Check internet connection
2. Verify base URL is correct in `.env.local`
3. Check if provider is experiencing downtime

## Advanced Configuration

### Changing Failover Order

Edit [../ai-proxy/src/providers/providerManager.ts](../ai-proxy/src/providers/providerManager.ts):

```typescript
private getActiveProvider(tokenEstimate: number): ActiveProvider | null {
  // Current order: Groq → Gemini → OpenRouter → Cloudflare → Ollama → null
  // Edit this method to change priority
}
```

### Custom Rate Limits

Override default limits in `.env.local`:

```bash
# Groq with custom RPM
GROQ_RATE_LIMIT_RPM=20  # Instead of default 30
```

### Persistent Queue Storage

Configure queue persistence for reliability:

```bash
QUEUE_PERSIST_PATH=/data/karakeep-queue.jsonl
```

## Architecture

### Request Flow

```
User Request
    ↓
AI Proxy (Port 8080)
    ↓
    ├─→ Groq (RPM: 30) ────────┐
    ├─→ Gemini (RPM: 15) ──────┤
    ├─→ OpenRouter (RPM: 20) ──┤
    ├─→ Cloudflare (RPM: 300) ─┼─→ Available?
    ├─→ Ollama (if enabled) ───┤    + Rate limit OK?
    └─→ Queue (Persistent) ────┘    + Daily quota OK?
         ↓
    Response to User
```

### Rate Limiting Strategy

Each provider has a `RateLimiter` that tracks:
- **RPM (Requests Per Minute):** Enforced strictly via sliding window
- **TPM (Tokens Per Minute):** Estimated at 1000 tokens/request
- **TPD (Tokens Per Day):** Tracked separately for daily budgets
- **RPD (Requests Per Day):** Daily request quota

When a provider approaches `EXHAUSTION_THRESHOLD` (default: 85%), it's marked exhausted and failover occurs.

## Support & Resources

- **GitHub:** [karakeep repo](https://github.com/yourusername/karakeep)
- **Groq Console:** https://console.groq.com/
- **Gemini API:** https://makersuite.google.com/
- **OpenRouter:** https://openrouter.ai/
- **Cloudflare Docs:** https://developers.cloudflare.com/workers-ai/

## License

MIT
