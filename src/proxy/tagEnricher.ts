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
1. Debes priorizar SIEMPRE seleccionar etiquetas de esta lista maestra si coinciden conceptual o temáticamente con el artículo.
2. Está estrictamente PROHIBIDO inventar sinónimos o variantes léxicas (ej. plurales o términos en inglés) si ya existe un concepto equivalente en la lista.
3. ESTRUCTURA EN 2 NIVELES OBLIGATORIA — devolvé exactamente 5 etiquetas en total:
   - NIVEL GENERAL (exactamente 2 etiquetas): elegí de la lista maestra los conceptos amplios que coincidan con el tema del artículo.
   - NIVEL ESPECÍFICO (exactamente 3 etiquetas): generá etiquetas que bajen un peldaño conceptual respecto al nivel general, nombrando el sub-tema, caso, autor, país, evento o mecanismo CONCRETO del artículo (ej.: si el nivel general es "marxismo", el nivel específico podría ser "teoria-del-valor" o "debate-partido-sindicato", según lo que el texto realmente trate). Que un concepto más amplio ya exista en la lista maestra (ver regla 1) SOLO te exime de inventar una etiqueta general redundante — nunca te exime de generar las 3 etiquetas específicas del nivel 2.
   - TEST DE UNICIDAD para el nivel específico: antes de asignar cada etiqueta específica, evaluá si serviría igual para decenas de artículos distintos sobre el mismo tema general — incluso si es un nombre propio, institución o país que aparece recurrentemente en ese tipo de cobertura. Si la respuesta es sí, esa etiqueta es de nivel general, no específico; usá en cambio el hecho, documento, mecanismo o hallazgo puntual que hace única a esta nota en particular.
4. FORMATO OBLIGATORIO: Todas las etiquetas deben estar en minúsculas y usar SIEMPRE guiones entre palabras (kebab-case, por ejemplo: 'politica-nacional', 'diseño-web'). Está estrictamente PROHIBIDO usar espacios en las etiquetas.
5. NEUTRALIDAD DE POSTURA: cada etiqueta (general o específica) debe reflejar lo que el artículo efectivamente ARGUMENTA, no el nombre "neutro" por defecto del tema. Un artículo puede tratar un concepto (ej. filantropía, libre mercado, meritocracia) para CRITICARLO o CUESTIONARLO, no para promoverlo. En esos casos usá una etiqueta que lo indique — ya sea un término específico ya reconocido para esa crítica (ej. "filantrocapitalismo") o una etiqueta descriptiva ("critica-meritocracia") — en vez de solo el nombre del concepto, que sugiere implícitamente una mirada favorable. No asumas la postura ideológica más común o "por defecto" sobre un tema: etiquetá según la posición real del texto, sea cual sea.
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
    logger.info(`Enriched Karakeep tagging request with ${tags.length} canonical tags`);
    return Buffer.from(JSON.stringify(body), 'utf8');
  }

  return bodyBuffer;
}

/**
 * Sanitizes LLM response content to ensure all tags in {"tags": [...]} are strictly in kebab-case.
 */
export function sanitizeTaggingResponse(responseBuffer: Buffer): Buffer {
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

  for (const choice of body['choices'] as Array<{ message?: { role?: string; content?: unknown } }>) {
    if (typeof choice?.message?.content === 'string') {
      const content = choice.message.content.trim();
      const cleanContent = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      try {
        const parsedContent = JSON.parse(cleanContent);
        if (parsedContent && Array.isArray(parsedContent.tags)) {
          const sanitizedTags = parsedContent.tags
            .filter((t: unknown): t is string => typeof t === 'string' && t.trim().length > 0)
            .map(normalizeToKebab)
            .filter((t: string) => t.length > 0);

          parsedContent.tags = sanitizedTags;
          choice.message.content = JSON.stringify(parsedContent);
          modified = true;
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
