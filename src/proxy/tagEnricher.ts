import fs from 'fs';
import { createLogger } from '../logger.js';

const logger = createLogger('TagEnricher');

const DEFAULT_TAGS_PATH = process.env['CANONICAL_TAGS_PATH'] || './data/canonical_tags.json';

interface CachedTags {
  filePath: string;
  tags: string[];
  mtime: number;
  lastChecked: number;
}

let tagCache: CachedTags | null = null;
const CACHE_TTL_MS = 10_000; // Check file mtime at most every 10s

export function clearTagCache(): void {
  tagCache = null;
}

export function normalizeToKebab(tag: string): string {
  return tag
    .toLowerCase()
    .trim()
    .replace(/^[\s#"'`]+|[\s#"'`]+$/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function loadCanonicalTags(customPath?: string): string[] {
  const filePath = customPath || DEFAULT_TAGS_PATH;
  const now = Date.now();

  if (tagCache && tagCache.filePath === filePath && now - tagCache.lastChecked < CACHE_TTL_MS) {
    return tagCache.tags;
  }

  try {
    if (!fs.existsSync(filePath)) {
      if (!tagCache || tagCache.filePath !== filePath) {
        logger.warn(`Canonical tags file not found at ${filePath}. Proceeding without tag enrichment.`);
      }
      return [];
    }

    const stat = fs.statSync(filePath);
    if (tagCache && tagCache.filePath === filePath && stat.mtimeMs <= tagCache.mtime) {
      tagCache.lastChecked = now;
      return tagCache.tags;
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const tags = parsed
        .filter((t: unknown): t is string => typeof t === 'string' && t.trim().length > 0)
        .map(normalizeToKebab)
        .filter((t) => t.length > 0);
      const uniqueTags = Array.from(new Set(tags));
      tagCache = {
        filePath,
        tags: uniqueTags,
        mtime: stat.mtimeMs,
        lastChecked: now,
      };
      logger.info(`Loaded ${uniqueTags.length} canonical tags from ${filePath}`);
      return uniqueTags;
    }
  } catch (err) {
    logger.error(`Error loading canonical tags from ${filePath}:`, err);
  }

  return tagCache && tagCache.filePath === filePath ? tagCache.tags : [];
}

/**
 * Checks if a request payload looks like Karakeep's automatic tagging prompt.
 */
export function isKarakeepTaggingRequest(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body['messages']) || body['messages'].length === 0) {
    return false;
  }

  for (const msg of body['messages'] as Array<{ role?: string; content?: unknown }>) {
    if (typeof msg?.content === 'string') {
      const content = msg.content;
      if (
        content.includes('automatic tagging for a read-it-later/bookmarking app') ||
        (content.includes('suggest relevant tags that describe its key themes') && content.includes('"tags"'))
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * JSON Schema para forzar el conteo exacto de etiquetas a nivel de generación
 * estructurada, en vez de depender de una instrucción en prosa que los modelos
 * (chicos y grandes) vienen ignorando de forma consistente. 5 campos NOMBRADOS
 * y `required` en vez de un array con minItems/maxItems, porque minItems/maxItems
 * en arrays NO está soportado por el subconjunto de JSON Schema que usa Groq/OpenAI
 * en modo `strict: true` (sí lo soporta Gemini, pero no de forma pareja entre
 * proveedores) — objetos con propiedades fijas sí es portable entre ambos.
 */
export const TAGGING_RESPONSE_SCHEMA = {
  type: 'object',
  description:
    'Etiquetas para un artículo guardado en un sistema de bookmarking. ' +
    'IDIOMA: todos los valores deben estar en ESPAÑOL, sin excepción — nunca en inglés, aunque el artículo o tu razonamiento interno estén en inglés. ' +
    'Regla de postura: si el artículo critica o cuestiona un concepto (ej. filantropía, meritocracia, libre mercado), ' +
    'la etiqueta debe reflejar esa crítica (ej. "critica-meritocracia", o un término ya reconocido como "filantrocapitalismo") ' +
    'en vez del nombre neutro del concepto, que sugiere implícitamente una mirada favorable. ' +
    'No asumas la postura ideológica más común o "por defecto" sobre un tema: etiquetá según lo que el texto efectivamente argumenta.',
  properties: {
    general_1: {
      type: 'string',
      description:
        'Etiqueta general 1, EN ESPAÑOL: de la lista maestra de tags canónicos provista en el prompt, el concepto amplio que mejor resume el tema del artículo.',
    },
    general_2: {
      type: 'string',
      description:
        'Etiqueta general 2, EN ESPAÑOL: de la lista maestra, sobre un EJE DISTINTO al de general_1 — no repitas el mismo concepto con otra redacción ' +
        '(ej. "argentina" y "politica-argentina" cuentan como el mismo eje, no como dos ejes distintos).',
    },
    especifico_1: {
      type: 'string',
      description:
        'Etiqueta específica 1, EN ESPAÑOL (traducila si el término te sale en inglés): el sub-tema, caso, documento, autor o mecanismo CONCRETO del artículo. ' +
        'Test de unicidad: si esta etiqueta serviría igual para decenas de artículos distintos sobre el mismo tema general ' +
        '— incluso si es un nombre propio o institución recurrente — NO es específica; buscá el hecho puntual de esta nota en particular.',
    },
    especifico_2: {
      type: 'string',
      description: 'Etiqueta específica 2, EN ESPAÑOL: mismo criterio que especifico_1, un ángulo CONCRETO distinto del artículo.',
    },
    especifico_3: {
      type: 'string',
      description: 'Etiqueta específica 3, EN ESPAÑOL: mismo criterio, un tercer ángulo CONCRETO distinto a los dos anteriores.',
    },
    especifico_4: {
      type: 'string',
      description: 'Etiqueta específica 4, EN ESPAÑOL: mismo criterio, un cuarto ángulo CONCRETO distinto a los tres anteriores.',
    },
  },
  required: ['general_1', 'general_2', 'especifico_1', 'especifico_2', 'especifico_3', 'especifico_4'],
  additionalProperties: false,
} as const;

/**
 * Providers cuyo soporte de `response_format: json_schema` con `strict: true`
 * está confirmado (Groq y Gemini). Para el resto (Cloudflare, Ollama) no hay
 * garantía documentada pareja, así que forwardRequest.ts lo retira del body
 * antes de reenviar y esos proveedores siguen dependiendo solo del rulesText.
 */
export const STRUCTURED_OUTPUT_SUPPORTED_PROVIDERS = new Set(['groq', 'gemini', 'openrouter']);

/**
 * Injects the canonical tags and strict anti-fragmentation rules into Karakeep's tagging prompt.
 */
export function enrichTaggingRequest(bodyBuffer: Buffer, customTagsPath?: string): Buffer {
  if (bodyBuffer.length === 0) return bodyBuffer;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyBuffer.toString('utf8'));
  } catch {
    return bodyBuffer;
  }

  if (!isKarakeepTaggingRequest(body)) {
    return bodyBuffer;
  }

  const tags = loadCanonicalTags(customTagsPath);
  if (!tags || tags.length === 0) {
    return bodyBuffer;
  }

  const tagsListStr = tags.join(', ');

  const rulesText = `
TAXONOMÍA Y REGLAS DE ETIQUETAS PREEXISTENTES:
A continuación se proporciona la lista maestra de etiquetas consolidadas y preferidas en el sistema:
[${tagsListStr}]

REGLAS ESTRICTAS DE ETIQUETADO:
1. IDIOMA OBLIGATORIO: absolutamente todas las etiquetas deben estar escritas en ESPAÑOL. Está PROHIBIDO usar inglés, incluso para conceptos que te resulten más naturales en inglés (ej. "dolarizacion", NUNCA "dollarization"; "deuda-publica", NUNCA "public debt"). Si el artículo está en español (como en este caso), no hay ninguna razón para responder en otro idioma.
2. Debes priorizar SIEMPRE seleccionar etiquetas de esta lista maestra si coinciden conceptual o temáticamente con el artículo, para los campos de nivel general (general_1, general_2).
3. Está estrictamente PROHIBIDO inventar sinónimos o variantes léxicas (ej. plurales o términos en inglés) si ya existe un concepto equivalente en la lista.
4. Los campos específicos (especifico_1, especifico_2, especifico_3, especifico_4) NO tienen que salir de la lista maestra — al contrario, deben bajar un peldaño conceptual respecto al nivel general y nombrar el sub-tema, caso, autor, país, evento o mecanismo CONCRETO del artículo.
5. FORMATO OBLIGATORIO: Todas las etiquetas deben estar en minúsculas y usar SIEMPRE guiones entre palabras (kebab-case, por ejemplo: 'politica-nacional', 'diseño-web'). Está estrictamente PROHIBIDO usar espacios en las etiquetas.

La estructura exacta de campos (2 generales + 4 específicos) y la regla de neutralidad de postura ya están definidas en el schema de respuesta — seguí esas descripciones al completar cada campo. IMPORTANTE: ignorá cualquier instrucción más abajo en este mensaje que pida devolver un campo llamado "tags" — esa instrucción quedó obsoleta; completá ÚNICAMENTE los campos definidos en el schema de respuesta (general_1, general_2, especifico_1, especifico_2, especifico_3, especifico_4).
`;

  const messages = body['messages'] as Array<{ role: string; content: string }>;
  let enriched = false;

  for (const msg of messages) {
    if (
      typeof msg.content === 'string' &&
      msg.content.includes('automatic tagging for a read-it-later/bookmarking app')
    ) {
      if (msg.content.includes('<TEXT_CONTENT>')) {
        msg.content = msg.content.replace('<TEXT_CONTENT>', `${rulesText}\n<TEXT_CONTENT>`);
      } else {
        msg.content = `${rulesText}\n\n${msg.content}`;
      }
      enriched = true;
      break;
    }
  }

  if (enriched) {
    // Adjuntamos response_format acá (provider-agnóstico); forwardRequest.ts
    // lo retira según el proveedor que termine atendiendo el request.
    body['response_format'] = {
      type: 'json_schema',
      json_schema: {
        name: 'karakeep_tags_v2',
        strict: true,
        schema: TAGGING_RESPONSE_SCHEMA,
      },
    };
    logger.info(`Enriched Karakeep tagging request with ${tags.length} canonical tags + structured output schema`);
    return Buffer.from(JSON.stringify(body), 'utf8');
  }

  return bodyBuffer;
}

/**
 * Convierte el shape de 5 campos nombrados (general_1, general_2, especifico_1..3)
 * al formato plano {"tags": [...]} que Karakeep espera. Si el contenido ya viene
 * como {"tags": [...]} (proveedores sin response_format, ej. Cloudflare/Ollama),
 * lo deja pasar sin tocar.
 */
function normalizeStructuredTagFields(parsedContent: Record<string, unknown>): string[] | null {
  const fieldOrder = ['general_1', 'general_2', 'especifico_1', 'especifico_2', 'especifico_3', 'especifico_4'];
  if (!fieldOrder.every((f) => typeof parsedContent[f] === 'string')) {
    return null;
  }
  return fieldOrder.map((f) => parsedContent[f] as string);
}

/**
 * Sanitizes LLM response content to ensure all tags in {"tags": [...]} are strictly in kebab-case.
 * Además, cuando el shape es el estructurado (5 campos), valida en código el CRITERIO A
 * (¿el valor específico está en la lista maestra?) en vez de confiar en que el LLM haya
 * escaneado bien una lista de cientos de tags — eso falla en silencio con listas largas
 * (ver canonical_tags.json real: 804 entradas), así que lo chequeamos acá con certeza.
 */
export function sanitizeTaggingResponse(responseBuffer: Buffer, customTagsPath?: string): Buffer {
  if (responseBuffer.length === 0) return responseBuffer;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(responseBuffer.toString('utf8'));
  } catch {
    return responseBuffer;
  }

  if (!Array.isArray(body['choices']) || body['choices'].length === 0) {
    return responseBuffer;
  }

  let modified = false;
  const canonicalSet = new Set(loadCanonicalTags(customTagsPath).map(normalizeToKebab));

  for (const choice of body['choices'] as Array<{ message?: { role?: string; content?: unknown } }>) {
    if (typeof choice?.message?.content === 'string') {
      const content = choice.message.content.trim();
      const cleanContent = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      try {
        const parsedContent = JSON.parse(cleanContent);
        if (parsedContent && typeof parsedContent === 'object') {
          // Shape nuevo: 5 campos nombrados (response_format estructurado) → aplanar a "tags"
          const structuredTags = normalizeStructuredTagFields(parsedContent as Record<string, unknown>);
          const rawTags = structuredTags ?? (Array.isArray(parsedContent.tags) ? parsedContent.tags : null);

          if (rawTags) {
            let sanitizedTags = rawTags
              .filter((t: unknown): t is string => typeof t === 'string' && t.trim().length > 0)
              .map(normalizeToKebab)
              .filter((t: string) => t.length > 0);

            // Validación programática del CRITERIO A: si esto vino del shape estructurado,
            // las posiciones 2 en adelante son las específicas — no deberían estar en la
            // lista maestra. A diferencia de antes, ahora se DESCARTAN (no solo se loguean):
            // es preferible un bookmark con menos etiquetas que una específica reciclada de
            // la lista general. Puede resultar en quedarse solo con general_1/general_2 si
            // las 4 específicas violan el criterio — aceptado como comportamiento válido.
            if (structuredTags && canonicalSet.size > 0) {
              const generales = sanitizedTags.slice(0, 2);
              const especificos = sanitizedTags.slice(2);
              const violaciones = especificos.filter((tag: string) => canonicalSet.has(tag));
              if (violaciones.length > 0) {
                logger.warn(
                  `CRITERIO A violado (en código, no por el modelo): se descartan las etiquetas específicas [${violaciones.join(', ')}] por coincidir con la lista canónica — el modelo no las detectó como tales.`
                );
                sanitizedTags = [...generales, ...especificos.filter((tag: string) => !canonicalSet.has(tag))];
              }
            }

            // Siempre devolvemos {"tags": [...]} — es lo único que Karakeep sabe leer,
            // sin importar si el proveedor devolvió el shape de 5 campos o el viejo array.
            const normalizedContent = { tags: sanitizedTags };
            choice.message.content = JSON.stringify(normalizedContent);
            modified = true;
          }
        }
      } catch {
        // Not JSON content, leave as is
      }
    }
  }

  if (modified) {
    logger.debug('Sanitized tagging response tags into kebab-case');
    return Buffer.from(JSON.stringify(body), 'utf8');
  }

  return responseBuffer;
}