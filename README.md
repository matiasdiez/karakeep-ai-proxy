# Karakeep AI Proxy

[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev/)
[![Docker](https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white)](#-docker)

Proxy HTTP en Node.js/TypeScript, compatible con la API de OpenAI, que se ubica entre [Karakeep](https://github.com/karakeep-app/karakeep) y varios proveedores de inferencia LLM (**Groq**, **Gemini**, **OpenRouter**, **Cloudflare Workers AI** y **Ollama**) para poder procesar un backlog masivo de bookmarks usando **solo planes gratuitos**, sin que los rate limits los marquen como fallidos.

## 🧩 El problema que resuelve

Karakeep usa un LLM para taggear y resumir cada bookmark que guardás. Si el backlog es grande (miles de artículos), cualquier tier gratuito de un solo proveedor se agota en minutos y Karakeep empieza a marcar jobs como fallidos en BullMQ. Este proxy actúa como una capa intermedia que:

- Reparte la carga entre **varios proveedores gratuitos en cascada**, saltando al siguiente *antes* de pegar contra el rate limit real (no cuando ya explotó con un 429).
- **Encola** las solicitudes que no puede procesar en vez de rechazarlas, para que Karakeep nunca vea un error.
- De noche, cuando el tráfico humano es bajo, enruta automáticamente a un modelo **local (Ollama)** sin límite de cuota.
- Opcionalmente, intercepta las peticiones de etiquetado y les inyecta una taxonomía propia de tags canónicos con reglas de consistencia (ver [Enriquecimiento de tags](#-enriquecimiento-de-tags-y-taxonomía-tagenricher)).

## 📑 Índice

- [Qué hace](#-qué-hace)
- [Arquitectura / flujo de estados](#-arquitectura--flujo-de-estados)
- [Requisitos](#-requisitos)
- [Instalación](#-instalación)
  - [Como contenedor junto a Karakeep](#opción-a--como-contenedor-junto-a-karakeep-uso-previsto)
  - [Standalone (Docker)](#opción-b--standalone-con-docker)
  - [Desarrollo local sin Docker](#opción-c--desarrollo-local-sin-docker)
- [Configuración (variables de entorno)](#-configuración-variables-de-entorno)
- [Endpoints](#-endpoints)
- [Enriquecimiento de tags y taxonomía](#-enriquecimiento-de-tags-y-taxonomía-tagenricher)
- [Estructura del proyecto](#-estructura-del-proyecto)
- [Tests](#-tests)
- [Límites de los tiers gratuitos](#-límites-sugeridos-tier-gratuito--verificar-en-cada-dashboard)
- [Troubleshooting](#-troubleshooting)
- [Licencia](#-licencia)

## ✅ Qué hace

- Expone un único endpoint OpenAI-compatible en `http://ai-proxy:8080/v1`, pensado para setear como `OPENAI_BASE_URL` en Karakeep (u otro cliente compatible con la API de OpenAI).
- Aplica **failover automático en cascada** entre proveedores: `Groq → Gemini → OpenRouter → Cloudflare → cola`, configurable vía `PROVIDER_ORDER`.
- De noche (fuera de la ventana `ACTIVE_HOURS_START`–`ACTIVE_HOURS_END`), enruta automáticamente a **Ollama local**, sin intervención manual.
- Lleva la cuenta de RPM/TPM/TPD/RPD por proveedor con una ventana deslizante y hace failover **proactivo** al alcanzar `EXHAUSTION_THRESHOLD` (80% por defecto) — antes de recibir un 429 real.
- Si de todos modos llega un 429, lo interpreta como "proveedor agotado" y falla-sobre al instante.
- Las solicitudes que no pueden procesarse en el momento se **encolan** (nunca se responde con un 5xx) para que BullMQ no las marque como fallidas.
- La cola es persistente en disco (`QUEUE_PERSIST_PATH`), así que sobrevive a un reinicio del contenedor.
- Expone `GET /status` y `GET /health` para observabilidad.
- Opcionalmente, **enriquece las peticiones de etiquetado** de Karakeep con una taxonomía propia de tags (ver más abajo).

## 🔀 Arquitectura / flujo de estados

A alto nivel es una cascada simple: `Groq → Gemini → OpenRouter → Cloudflare → cola`, y fuera del horario activo (`ACTIVE_HOURS_START`–`ACTIVE_HOURS_END`) todo se enruta a Ollama local. El orden se configura con `PROVIDER_ORDER`.

Donde está la parte no trivial es en el detalle de cada salto:

- **Rate limiting por ventana deslizante, no por contador fijo**: cada proveedor trackea 4 métricas en paralelo (RPM, TPM, TPD, RPD) con ventanas independientes — un contador ingenuo que resetea cada minuto exacto permite ráfagas dobles en el borde de la ventana; la ventana deslizante no.
- **Failover proactivo, no solo reactivo**: el proxy cambia de proveedor al llegar a `EXHAUSTION_THRESHOLD` (80% por defecto) del límite más restrictivo de las 4 métricas, *antes* de que el proveedor devuelva un 429. Si igual llega un 429 real, lo toma como señal adicional de agotamiento.
- **Cola persistida en disco, no en memoria**: las solicitudes que no se pueden procesar se escriben a `QUEUE_PERSIST_PATH` en vez de perderse; un restart del contenedor (deploy, OOM, `docker compose down`) no descarta trabajo pendiente.
- **Shutdown graceful con timeout**: al recibir `SIGTERM`/`SIGINT`, deja de aceptar conexiones nuevas, vacía la cola a disco y da 30s antes de forzar la salida — para no cortar una escritura a mitad de camino.
- **Recarga en caliente de la taxonomía de tags**: `canonical_tags.json` se cachea en memoria y se compara su `mtime` cada 10s, así que se puede editar la lista de tags sin reiniciar el proxy.

Esa lógica está cubierta por los tests en `src/tests/` (`rateLimiter.test.ts`, `activeHours.test.ts`, `providerManager.test.ts`, `tagEnricher.test.ts`), que es donde se ve mejor el comportamiento real que en cualquier diagrama.

## 📋 Requisitos

- Node.js ≥ 20
- [pnpm](https://pnpm.io/) (el repo usa `pnpm-lock.yaml`)
- Docker y Docker Compose (opcional, recomendado para producción)
- Al menos una API key de un proveedor soportado ([ver tabla de límites](#-límites-sugeridos-tier-gratuito--verificar-en-cada-dashboard))

## 🚀 Instalación

### Opción A — Como contenedor junto a Karakeep (uso previsto)

Este proxy está pensado para correr como un servicio más dentro del `docker-compose.yml` de Karakeep, apuntando `OPENAI_BASE_URL` hacia él.

**1. Configurar el proxy**

```bash
cd ai-proxy
cp .env.example .env
nano .env   # completar las API keys reales
```

**2. Agregar el servicio al `docker-compose.yml` de Karakeep**

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

**3. Levantar el stack**

```bash
docker compose up -d
```

**4. Verificar que funciona**

```bash
curl http://localhost:8081/status | python3 -m json.tool
docker compose logs -f ai-proxy
```

> Los nombres de servicio, puertos y el mecanismo para reapuntar `OPENAI_BASE_URL` dependen de cómo tengas armado tu propio `docker-compose.yml` de Karakeep — el snippet de arriba es un punto de partida, no un contrato fijo.

### Opción B — Standalone con Docker

Para probar el proxy solo, sin Karakeep:

```bash
cd ai-proxy
cp .env.example .env
# Editar .env con tus API keys

docker build -t ai-proxy .
docker run -d --name ai-proxy \
  --env-file .env \
  -p 8080:8080 \
  -v $(pwd)/data:/app/data \
  ai-proxy
```

### Opción C — Desarrollo local (sin Docker)

```bash
cd ai-proxy
pnpm install
cp .env.example .env
# Editar .env
pnpm run build
node dist/index.js

# o en modo watch:
pnpm run dev
```

## ⚙️ Configuración (variables de entorno)

Todas las variables están documentadas con sus valores por defecto en [`.env.example`](./.env.example). Resumen por proveedor:

| Proveedor | Variables clave | Obligatorio |
|---|---|---|
| **Groq** | `GROQ_API_KEY`, `GROQ_MODEL`, `GROQ_RATE_LIMIT_{RPM,TPM,TPD,RPD}` | Sí |
| **Gemini** | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_RATE_LIMIT_{RPM,TPM,TPD,RPD}` | Sí |
| **OpenRouter** | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_RATE_LIMIT_{RPM,RPD}` | Sí |
| **Cloudflare Workers AI** | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_MODEL`, `CLOUDFLARE_RATE_LIMIT_{RPM,TPD}` | Sí |
| **Ollama** (local) | `ENABLE_OLLAMA`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | No (default `true`, requiere Ollama corriendo) |

> Groq, Gemini, OpenRouter y Cloudflare son requeridos en `config.ts` (el proceso no arranca sin sus API keys). Si no querés usar alguno de los cuatro, la forma más simple es dejar una key dummy y excluirlo de `PROVIDER_ORDER`.

Variables generales del proxy:

| Variable | Default | Descripción |
|---|---|---|
| `PROXY_PORT` | `8080` | Puerto del servidor HTTP |
| `PROVIDER_ORDER` | `groq,gemini,openrouter,cloudflare` | Orden de la cascada de failover |
| `EXHAUSTION_THRESHOLD` | `0.80` | % del límite en el que se considera "agotado" un proveedor (failover proactivo) |
| `WAIT_MAX_MS` | `20000` | Tiempo máx. (ms) que se mantiene abierta la conexión antes de encolar |
| `QUEUE_PERSIST_PATH` | — | Path para persistir la cola entre reinicios (ej. `/app/data/queue.json`) |
| `ACTIVE_HOURS_START` / `ACTIVE_HOURS_END` | `07:00` / `22:00` | Ventana horaria en la que se usa la cascada cloud; fuera de ella, Ollama |
| `TIMEZONE` | `America/Argentina/Buenos_Aires` | Zona horaria para calcular `ACTIVE_HOURS_*` |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `CANONICAL_TAGS_PATH` | `./data/canonical_tags.json` | Path del archivo de tags canónicos para el `tagEnricher` (opcional) |

**Dónde conseguir cada API key:**

| Proveedor | Dónde conseguirla |
|---|---|
| Groq | [console.groq.com/keys](https://console.groq.com/keys) |
| Gemini | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) |
| Cloudflare Workers AI | [dash.cloudflare.com](https://dash.cloudflare.com/) → *Manage Account → Tokens* (scope *Workers AI*) + Account ID en *Account Overview* |

## 🔌 Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/v1/*` | Endpoint OpenAI-compatible; reenvía al proveedor activo según la máquina de estados |
| `GET` | `/status` | Estado actual: proveedor activo, uso de cuota por proveedor, tamaño de la cola |
| `GET` | `/health` | Health check simple (`{ ok: true }`) |

Ejemplo de `GET /status`:

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

## 🏷️ Enriquecimiento de tags y taxonomía (`tagEnricher`)

Este es un módulo **opcional** pensado para mi propio caso de uso (un backlog de lectura con una taxonomía de tags curada a mano); si no te interesa, alcanza con no proveer `CANONICAL_TAGS_PATH` / `canonical_tags.json` y el proxy sigue funcionando como un proxy de failover puro.

Cuando está activo, el proxy intercepta de forma transparente las solicitudes de etiquetado automático de Karakeep (`/v1/chat/completions`) e inyecta la lista maestra de tags canónicos junto con directivas de categorización:

1. **Estructura obligatoria en 2 niveles con cupos fijos (exactamente 5 etiquetas)**
   - **Nivel general (2 etiquetas)**: conceptos amplios tomados de la lista canónica preexistente (ej. `marxismo`, `economia`, `cine`), para catalogación y búsqueda global.
   - **Nivel específico (3 etiquetas)**: un peldaño más concreto — sub-tema, caso de estudio, autor, país, evento o mecanismo del texto (ej. si el nivel general es `marxismo`, el específico puede ser `teoria-del-valor` o `acumulacion-por-desposesion`).
   - El cupo fijo (2 + 3 = 5) evita que modelos chicos (Groq/Gemini Flash/Llama en Cloudflare) tomen el camino fácil y devuelvan solo categorías paraguas.

2. **Resolución de la contradicción "normalizar vs. detallar"**: que un concepto amplio ya exista en la lista maestra solo exime de inventar una etiqueta general redundante — nunca exime de generar las 3 etiquetas específicas de nivel 2.

3. **Neutralidad de postura / anti-sesgo nominal**: cada etiqueta refleja lo que el artículo efectivamente *argumenta*, en vez del sesgo estadístico típico de los LLM de asignar el nombre "neutro" del concepto a textos que lo cuestionan. Si un artículo critica un concepto (ej. filantropía, libre mercado, meritocracia), la etiqueta debe capturar esa crítica (`filantrocapitalismo`, `critica-meritocracia`) en vez del término afirmativo (`filantropia`).

4. **Normalización estricta (`kebab-case`)**: todas las etiquetas se fuerzan a minúsculas, separadas por guiones, sin espacios ni caracteres especiales. `sanitizeTaggingResponse()` valida y sanea la respuesta JSON del modelo antes de entregarla a Karakeep.

5. **Recarga en caliente**: el archivo de tags canónicos se cachea en memoria y su `mtime` se revisa cada 10 segundos, recargándose solo si cambió — sin reiniciar el contenedor.

## 🗂️ Estructura del proyecto

```
ai-proxy/
├── src/
│   ├── config.ts                    # Lee y valida env vars
│   ├── logger.ts                    # Logger con niveles
│   ├── index.ts                     # Entrada, Express, shutdown graceful
│   ├── providers/
│   │   ├── types.ts                 # Interfaces y enums
│   │   ├── rateLimiter.ts           # Ventana deslizante RPM/TPM + TPD/RPD diario
│   │   └── providerManager.ts       # Máquina de estados Groq/Gemini/OpenRouter/Cloudflare/Ollama
│   ├── proxy/
│   │   ├── forwardRequest.ts        # Reenvío HTTP + reescritura de modelo
│   │   ├── handler.ts               # Handler Express + drainer de cola
│   │   └── tagEnricher.ts           # Interceptor e inyector de tags canónicos (opcional)
│   ├── queue/
│   │   └── requestQueue.ts          # Cola FIFO con persistencia en disco
│   ├── routes/
│   │   └── status.ts                # GET /status + GET /health
│   ├── scripts/
│   │   └── manualTagTest.ts         # Script manual para probar el tagEnricher
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

## 🧪 Tests

```bash
cd ai-proxy
pnpm test          # una corrida
pnpm test:watch    # modo watch
```

Cubren la lógica de rate limiting (ventana deslizante RPM/TPM/TPD), el cálculo de horario activo, la máquina de estados del `ProviderManager` y el saneamiento de tags del `tagEnricher`.

## 📊 Límites sugeridos (tier gratuito) — verificar en cada dashboard

> ⚠️ Estos valores son estimados y cambian según el plan y el modelo. **Verificalos en tu propio dashboard antes de usar en producción.**

| Proveedor | Modelo de ejemplo | RPM | TPM | TPD | Costo |
|---|---|---|---|---|---|
| Groq | `openai/gpt-oss-20b` | 30 | 14,400 | 200,000 | Gratis |
| Gemini | `gemini-flash-lite-latest` | 15 | 1,000,000 | sin límite | Gratis |
| OpenRouter | modelos `:free` | 20 | — | basado en créditos | Gratis |
| Cloudflare Workers AI | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 300 | — | 10,000 neurons/día | Gratis |
| Ollama | `qwen2.5:7b` (local) | ∞ | ∞ | ∞ | Gratis (tu hardware) |

- Groq: [console.groq.com/settings/limits](https://console.groq.com/settings/limits)
- Gemini: [ai.google.dev/gemini-api/docs/rate-limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- OpenRouter: `curl https://openrouter.ai/api/v1/auth/key -H "Authorization: Bearer $OPENROUTER_API_KEY"`
- Cloudflare: [developers.cloudflare.com/workers-ai](https://developers.cloudflare.com/workers-ai/platform/pricing/)

## 🛠️ Troubleshooting

| Síntoma | Causa probable | Solución |
|---|---|---|
| El proceso no arranca / `Missing required env var` | Falta una API key obligatoria en `.env` | Completá las 4 keys cloud en `.env`, o quitá ese proveedor de `PROVIDER_ORDER` y ajustá `config.ts` si querés hacerlo opcional |
| Todas las requests se encolan y nunca se resuelven | Todos los proveedores cloud agotados y `ENABLE_OLLAMA=false` (o Ollama no accesible) | Activá Ollama o esperá el reset diario de cuota |
| `ECONNREFUSED` contra Ollama | `OLLAMA_BASE_URL` apunta a `localhost` desde dentro de un contenedor | Usá `http://host.docker.internal:11434/v1` (o el hostname del servicio en tu red de Docker) |
| Karakeep sigue pegándole directo al proveedor | `OPENAI_BASE_URL` no apunta al proxy | Verificá que el worker de Karakeep tenga `OPENAI_BASE_URL=http://ai-proxy:8080/v1` |
| Las etiquetas no respetan el cupo de 5 | `tagEnricher` deshabilitado o `canonical_tags.json` ausente | Verificá `CANONICAL_TAGS_PATH` y que el archivo exista y sea JSON válido |

## 📄 Licencia

Este repositorio todavía no incluye un archivo `LICENSE`. Si vas a compartirlo públicamente, te conviene agregar uno (por ejemplo [MIT](https://choosealicense.com/licenses/mit/)) para dejar en claro qué pueden hacer otros con el código.
