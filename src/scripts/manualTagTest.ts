/**
 * Script manual para probar el prompt REAL de tagging (el mismo rulesText que
 * usa tagEnricher.ts en producción) contra un proveedor y modelo elegidos a
 * mano, sin pasar por Karakeep ni por la selección automática de proveedor
 * del proxy.
 *
 * Uso:
 *   npx tsx src/scripts/manualTagTest.ts --provider groq --file articulo.txt
 *   npx tsx src/scripts/manualTagTest.ts --provider openrouter --model "nvidia/nemotron-3-super-120b-a12b:free" --file articulo.txt
 *   npx tsx src/scripts/manualTagTest.ts --provider gemini --text "pegá el texto del artículo acá"
 *
 * Requiere: npm install --save-dev tsx   (una sola vez)
 * Lee las API keys de tu .env real (dotenv se carga automáticamente si existe).
 *
 * Proveedores soportados: groq, gemini, openrouter (OpenAI-compatible /chat/completions
 * con auth por API key), y ollama (local, sin cuota ni API key — requiere tener
 * `ollama serve` corriendo en tu máquina con el modelo ya descargado, ej. `ollama pull qwen2.5:7b`).
 * Cloudflare usa un formato de respuesta distinto y no está cubierto.
 */
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../config.js';
import { enrichTaggingRequest, STRUCTURED_OUTPUT_SUPPORTED_PROVIDERS } from '../proxy/tagEnricher.js';

// ── Carga simple de .env sin agregar dotenv como dependencia nueva ──────────
function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    value = value.replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

// ── Parseo de argumentos CLI ─────────────────────────────────────────────────
function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const providerArg = (getArg('provider') || 'groq').toLowerCase();
const modelOverride = getArg('model');
const filePath = getArg('file');
const inlineText = getArg('text');
const tagsPath = getArg('tags-path'); // opcional, por defecto usa CANONICAL_TAGS_PATH / ./data/canonical_tags.json

if (!filePath && !inlineText) {
  console.error('Falta --file <ruta.txt> o --text "contenido del artículo"');
  process.exit(1);
}

const articleText = inlineText ?? fs.readFileSync(filePath as string, 'utf8');

// ── Arma el body EXACTAMENTE con la forma que Karakeep manda a tagging ──────
// (isKarakeepTaggingRequest busca esta frase literal en el content)
const fakeKarakeepBody = {
  model: 'placeholder',
  messages: [
    {
      role: 'user',
      content:
        'You are an expert whose responsibility is to help with automatic tagging for a read-it-later/bookmarking app.\n' +
        `<TEXT_CONTENT>\n${articleText}\n</TEXT_CONTENT>\n` +
        'You must respond in JSON with the key "tags"',
    },
  ],
};

async function main(): Promise<void> {
  const config = loadConfig();

  const providers: Record<string, { baseUrl: string; apiKey: string; model: string }> = {
    groq: { baseUrl: config.groq.baseUrl, apiKey: config.groq.apiKey, model: config.groq.model },
    gemini: { baseUrl: config.gemini.baseUrl, apiKey: config.gemini.apiKey, model: config.gemini.model },
    openrouter: { baseUrl: config.openrouter.baseUrl, apiKey: config.openrouter.apiKey, model: config.openrouter.model },
    // Ollama corre local, sin cuota ni API key. El baseUrl por defecto
    // ('host.docker.internal') solo resuelve DENTRO de un contenedor Docker —
    // como este script corre en tu máquina directamente, lo pisamos a
    // localhost salvo que hayas seteado OLLAMA_BASE_URL vos mismo distinto.
    ollama: {
      baseUrl: config.ollama.baseUrl.includes('host.docker.internal')
        ? config.ollama.baseUrl.replace('host.docker.internal', 'localhost')
        : config.ollama.baseUrl,
      apiKey: 'ollama', // Ollama ignora este valor, pero el script siempre manda el header Authorization
      model: config.ollama.model,
    },
  };

  const selected = providers[providerArg];
  if (!selected) {
    console.error(`Proveedor "${providerArg}" no soportado por este script. Usá: groq, gemini, openrouter, ollama.`);
    process.exit(1);
  }

  const model = modelOverride || selected.model;

  // Reusa el enriquecedor REAL — mismo rulesText y response_format que corre en producción
  const enrichedBuffer = enrichTaggingRequest(Buffer.from(JSON.stringify(fakeKarakeepBody), 'utf8'), tagsPath);
  const enrichedBody = JSON.parse(enrichedBuffer.toString('utf8'));
  enrichedBody.model = model;

  // Mismo criterio que forwardRequest.ts: si el proveedor elegido no tiene
  // soporte confirmado de structured output, lo sacamos antes de mandar.
  if ('response_format' in enrichedBody && !STRUCTURED_OUTPUT_SUPPORTED_PROVIDERS.has(providerArg)) {
    console.log(`(proveedor "${providerArg}" sin soporte confirmado de response_format — se envía solo con rulesText)\n`);
    delete enrichedBody.response_format;
  }

  const url = `${selected.baseUrl.replace(/\/$/, '')}/chat/completions`;

  const debug = process.argv.includes('--debug');

  console.log(`→ Enviando a ${providerArg.toUpperCase()} (${model})`);
  if (debug) {
    console.log('── response_format enviado en el request ──────────────────');
    console.log(enrichedBody.response_format ? JSON.stringify(enrichedBody.response_format, null, 2) : '(no se envió response_format)');
    console.log('');
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${selected.apiKey}`,
    },
    body: JSON.stringify(enrichedBody),
  });

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  };

  if (!res.ok) {
    console.error(`✗ HTTP ${res.status}:`, JSON.stringify(data, null, 2));
    process.exit(1);
  }

  if (debug) {
    console.log('── Respuesta HTTP completa (cruda, sin procesar) ──────────');
    console.log(JSON.stringify(data, null, 2));
    console.log('');
    console.log(`finish_reason: ${data?.choices?.[0]?.finish_reason ?? '(no vino)'}`);
    console.log('');
  }

  const content = data?.choices?.[0]?.message?.content;
  console.log('── Respuesta cruda del modelo (message.content) ───────────');
  console.log(content ?? JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});