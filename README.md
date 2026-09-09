# Karakeep AI Proxy

Proxy HTTP en Node.js/TypeScript que se ubica entre [Karakeep](https://github.com/karakeep-app/karakeep) y varios proveedores de inferencia — **Groq**, **Gemini**, **OpenRouter**, **Cloudflare** y **Ollama** — para procesar un backlog masivo de bookmarks sin que ningún rate limit los marque como fallidos en BullMQ.

## ¿Qué hace?

- Expone un único endpoint OpenAI-compatible en `http://ai-proxy:8080/v1`
- Aplica **failover automático**: Groq → Gemini → espera (cola) durante el día
- De noche, enruta automáticamente a **Ollama local** sin intervención manual
- Aplica **enriquecimiento de taxonomía en 2 niveles y neutralidad de postura en tags**: intercepta peticiones de etiquetado de Karakeep e inyecta la lista de tags canónicos, exigiendo un cupo estricto de 5 etiquetas (2 generales de la lista + 3 específicas del tema concreto) y forzando que las etiquetas reflejen la postura real o crítica del texto (anti-sesgo nominal)
- Lleva la cuenta de RPM/TPM/TPD por proveedor y hace failover **proactivo** al 80% del límite (antes del 429 real)
- Si llega un 429 real, lo maneja como "proveedor agotado" y falla-sobre instantáneamente
- Las solicitudes que no pueden procesarse se **encolan** (no se rechazan con 5xx) para que BullMQ de Karakeep no las marque como fallidas
- La cola es persistente en disco (reiniciable sin perder jobs)

## Flujo de estados

```
[Groq activo]
   │ RPM/TPM/TPD ≥ 80% del límite ──→ [Gemini activo]
   │ 429 real de Groq              ──→ [Gemini activo]
   │
[Gemini activo]
   │ RPM/TPM/TPD ≥ 80% del límite ──→ [En espera / cola]
   │ 429 real de Gemini            ──→ [En espera / cola]
   │
[En espera / cola]
   │ Groq o Gemini recupera cuota  ──→ [vuelve al mejor proveedor]
   │ ACTIVE_HOURS_END alcanzado    ──→ [Ollama activo]
   │
[Ollama activo]  ← noche, sin límite de cuota
   │ ACTIVE_HOURS_START alcanzado  ──→ [Groq activo] (reset de contadores)
```

## Instalación y configuración

### 1. Configurar el proxy

```bash
cd ai-proxy
cp .env.example .env
# Editar .env con tus API keys reales
nano .env
```

Variables mínimas a cambiar:

| Variable | Dónde conseguirla |
|---|---|
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) |
| `GEMINI_API_KEY` | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |
| `TIMEZONE` | Tu zona horaria ([lista](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)) |

### 2. Activar el proxy en Karakeep

```bash
cd karakeep
make use-proxy
```

Esto copia `.env.proxy` → `.env` (que tiene `OPENAI_BASE_URL=http://ai-proxy:8080/v1`) y reinicia el worker de Karakeep.

### 3. Levantar el stack completo

```bash
cd karakeep
docker compose up -d
```

El servicio `ai-proxy` se construye automáticamente desde `../ai-proxy/Dockerfile`.

### 4. Verificar que funciona

```bash
# Estado del proxy (proveedor activo, cuota, tamaño de cola)
make proxy-status

# O directamente
curl http://localhost:8081/status | python3 -m json.tool

# Logs del proxy en tiempo real
make proxy-logs
```

## Detener el servicio

### Detener todo (liberar RAM y CPU)

```bash
cd ~/Web/karakeep/karakeep
docker compose down
```

Detiene y elimina todos los contenedores. Los datos (bookmarks, cola del proxy) quedan intactos en los volúmenes.

### Volver a levantarlo

```bash
docker compose up -d
```

> No necesita `--build` a menos que hayas cambiado código del proxy.

### Detener solo el proxy (dejar Karakeep corriendo)

Si necesitás liberar recursos pero mantener Karakeep activo, podés detener solo el proxy y apuntar Karakeep directo a un proveedor:

```bash
docker compose stop ai-proxy
make use-groq    # o use-gemini / use-ollama
```

Para retomar el proxy después:

```bash
docker compose start ai-proxy
make use-proxy
```

## Límites sugeridos (tier gratuito) — verificar en cada dashboard

> ⚠️ Estos valores son estimados. Los límites reales cambian según el plan y el modelo. **Verificalos en tu dashboard antes de usar en producción.**

| Proveedor | Modelo | RPM | TPM | TPD | ~bookmarks/día |
|---|---|---|---|---|---|
| Groq | `openai/gpt-oss-20b` | 30 | 14,400 | 200,000 | ~80 |
| Gemini | `gemini-3.5-flash` | 15 | 1,000,000 | sin límite | ~400+ |
| Ollama | `qwen2.5:7b` | ∞ | ∞ | ∞ | ∞ |

- Groq: [console.groq.com/settings/limits](https://console.groq.com/settings/limits)
- Gemini: [ai.google.dev/gemini-api/docs/rate-limits](https://ai.google.dev/gemini-api/docs/rate-limits)

## Coordinación con Ollama

El proxy detecta automáticamente cuándo estamos fuera de la ventana `ACTIVE_HOURS_START–ACTIVE_HOURS_END` y enruta a Ollama. No hace falta cron ni `make use-ollama`.

Si querés bypassear el proxy completamente (emergencia, debug):

```bash
make use-ollama   # Karakeep apunta directo a Ollama, sin pasar por el proxy
make use-proxy    # Vuelve a usar el proxy
```

## Enriquecimiento de Tags y Taxonomía (`tagEnricher`)

El proxy intercepta de forma transparente las solicitudes de etiquetado automático de Karakeep (`/v1/chat/completions`) e inyecta la lista maestra de tags canónicos (`canonical_tags.json`) junto con directivas precisas de categorización y encuadre temático.

### Cualidades del sistema de etiquetado:

1. **Estructura obligatoria en 2 niveles con cupos fijos (exactamente 5 etiquetas)**:
   - **Nivel General (exactamente 2 etiquetas)**: Conceptos amplios tomados de la lista canónica preexistente (`canonical_tags.json`, ~800 tags). Sirven para catalogación y búsqueda global (ej. `marxismo`, `economia`, `cine`).
   - **Nivel Específico (exactamente 3 etiquetas)**: Descienden un peldaño conceptual respecto al nivel general, nombrando el sub-tema, caso de estudio, autor, país, evento o mecanismo concreto del texto (ej. si el nivel general es `marxismo`, el nivel específico puede ser `teoria-del-valor`, `debate-partido-sindicato` o `acumulacion-por-desposesion`).
   - El cupo fijo (2 + 3 = 5) previene que modelos pequeños (como los de Groq, Gemini Flash o Llama en Cloudflare) adopten el camino de menor esfuerzo y devuelvan únicamente categorías paraguas.

2. **Resolución de contradicción en la regla de especificidad**:
   - Se instruye explícitamente al LLM que la existencia de un concepto amplio en la lista maestra **solo exime de inventar una etiqueta general redundante**, pero **nunca exime de generar las 3 etiquetas específicas del nivel 2**. Esto evita que la regla de normalización bloquee la generación de etiquetas detalladas.

3. **Neutralidad de postura y anti-sesgo nominal (*Stance Neutrality*)**:
   - Cada etiqueta refleja lo que el artículo efectivamente **argumenta**, evitando el sesgo estadístico común de los LLMs donde se asigna el nombre nominal o "neutro" del concepto a textos que lo cuestionan.
   - Si un artículo critica, refuta o cuestiona un concepto (ej. filantropía, libre mercado, meritocracia), la etiqueta debe capturar esa crítica —con un término ya establecido para ello (ej. `filantrocapitalismo`) o descriptivo (ej. `critica-meritocracia`, `precarizacion-laboral`)— en vez de utilizar el nombre afirmativo o neutral (`filantropia`), sugiriendo erróneamente una postura favorable.

4. **Normalización estricta (`kebab-case`)**:
   - Todas las etiquetas se fuerzan a minúsculas y palabras separadas por guiones sin espacios ni caracteres especiales (`#`, `'`, `"`).
   - `sanitizeTaggingResponse()` en el proxy valida y sanea programáticamente la respuesta JSON del modelo antes de entregarla a Karakeep, garantizando consistencia absoluta en la base de datos.

5. **Inyección de lista canónica completa con recarga en caliente**:
   - Mantiene la cobertura y coherencia de la taxonomía global inyectando las ~800 etiquetas canónicas en cada solicitud.
   - El archivo se cachea en memoria y verifica su timestamp de modificación (`mtime`) cada 10 segundos, recargándose automáticamente si se edita sin necesidad de reiniciar el contenedor.

## Estructura del proyecto

```
ai-proxy/
├── src/
│   ├── config.ts                    # Lee y valida env vars
│   ├── logger.ts                    # Logger con niveles
│   ├── index.ts                     # Entrada, Express, shutdown graceful
│   ├── providers/
│   │   ├── types.ts                 # Interfaces y enums
│   │   ├── rateLimiter.ts           # Ventana deslizante RPM/TPM + TPD diario
│   │   └── providerManager.ts       # Máquina de estados Groq/Gemini/Ollama
│   ├── proxy/
│   │   ├── forwardRequest.ts        # Reenvío HTTP + reescritura de modelo
│   │   ├── handler.ts               # Handler Express + drainer de cola
│   │   └── tagEnricher.ts           # Interceptor e inyector de tags canónicos
│   ├── queue/
│   │   └── requestQueue.ts          # Cola FIFO con persistencia JSON
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

## Desarrollo local (sin Docker)

```bash
cd ai-proxy
pnpm install
cp .env.example .env
# Editar .env
pnpm run build
node dist/index.js
```

## Tests

```bash
cd ai-proxy
pnpm test
```
