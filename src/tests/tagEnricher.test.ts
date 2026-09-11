import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  isKarakeepTaggingRequest,
  enrichTaggingRequest,
  loadCanonicalTags,
  normalizeToKebab,
  sanitizeTaggingResponse,
} from '../proxy/tagEnricher.js';

describe('TagEnricher', () => {
  let tempDir: string;
  let tempTagsPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-enricher-test-'));
    tempTagsPath = path.join(tempDir, 'canonical_tags.json');
    fs.writeFileSync(tempTagsPath, JSON.stringify(['economia', 'politica', 'redes sociales', 'marxismo']), 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('normalizes raw tag strings to strict kebab-case', () => {
    expect(normalizeToKebab('Politica Nacional')).toBe('politica-nacional');
    expect(normalizeToKebab('  diseño   web  ')).toBe('diseño-web');
    expect(normalizeToKebab('#Machine_Learning#')).toBe('machine-learning');
    expect(normalizeToKebab('---varios---guiones---')).toBe('varios-guiones');
  });

  it('correctly detects Karakeep tagging requests', () => {
    const taggingPayload = {
      model: 'test-model',
      messages: [
        {
          role: 'user',
          content: 'You are an expert whose responsibility is to help with automatic tagging for a read-it-later/bookmarking app.\n<TEXT_CONTENT>\nURL: https://example.com\n</TEXT_CONTENT>\nYou must respond in JSON with the key "tags"',
        },
      ],
    };
    expect(isKarakeepTaggingRequest(taggingPayload)).toBe(true);
  });

  it('ignores non-tagging requests', () => {
    const normalPayload = {
      model: 'test-model',
      messages: [
        {
          role: 'user',
          content: 'Summarize the following text in 3 bullet points.',
        },
      ],
    };
    expect(isKarakeepTaggingRequest(normalPayload)).toBe(false);
  });

  it('loads canonical tags from disk and enforces kebab-case', () => {
    const tags = loadCanonicalTags(tempTagsPath);
    expect(tags).toEqual(['economia', 'politica', 'redes-sociales', 'marxismo']);
  });

  it('enriches tagging prompt with canonical tags and kebab-case rules', () => {
    const rawPayload = {
      model: 'test-model',
      messages: [
        {
          role: 'user',
          content: 'You are an expert whose responsibility is to help with automatic tagging for a read-it-later/bookmarking app.\n<TEXT_CONTENT>\nArticle text\n</TEXT_CONTENT>\nYou must respond in JSON with the key "tags"',
        },
      ],
    };

    const inputBuffer = Buffer.from(JSON.stringify(rawPayload), 'utf-8');
    const enrichedBuffer = enrichTaggingRequest(inputBuffer, tempTagsPath);

    expect(enrichedBuffer).not.toEqual(inputBuffer);

    const parsed = JSON.parse(enrichedBuffer.toString('utf-8'));
    const enrichedContent = parsed.messages[0].content;

    expect(enrichedContent).toContain('TAXONOMÍA Y REGLAS DE ETIQUETAS PREEXISTENTES');
    expect(enrichedContent).toContain('economia, politica, redes-sociales, marxismo');
    expect(enrichedContent).toContain('FORMATO OBLIGATORIO: Todas las etiquetas deben estar en minúsculas y usar SIEMPRE guiones');
    expect(enrichedContent).toContain('<TEXT_CONTENT>');
    expect(enrichedContent).toContain('You must respond in JSON with the key "tags"');
  });

  it('enriches tagging prompt with rulesText + a structured response_format schema', () => {
    const rawPayload = {
      model: 'test-model',
      messages: [
        {
          role: 'user',
          content: 'You are an expert whose responsibility is to help with automatic tagging for a read-it-later/bookmarking app.\n<TEXT_CONTENT>\nArticle text\n</TEXT_CONTENT>\nYou must respond in JSON with the key "tags"',
        },
      ],
    };

    const inputBuffer = Buffer.from(JSON.stringify(rawPayload), 'utf-8');
    const enrichedBuffer = enrichTaggingRequest(inputBuffer, tempTagsPath);
    const parsed = JSON.parse(enrichedBuffer.toString('utf-8'));
    const enrichedContent = parsed.messages[0].content;

    // rulesText: prioriza lista maestra solo para los campos generales
    expect(enrichedContent).toContain('para los campos de nivel general (general_1, general_2)');
    expect(enrichedContent).toContain('FORMATO OBLIGATORIO');

    // Regla de idioma explícita (no solo implícita por escribir el prompt en español)
    expect(enrichedContent).toContain('IDIOMA OBLIGATORIO');
    expect(enrichedContent).toContain('PROHIBIDO usar inglés');

    // Resuelve la contradicción con la instrucción original de Karakeep ("key tags")
    expect(enrichedContent).toContain('ignorá cualquier instrucción más abajo');

    // response_format: el conteo/estructura ahora se fuerza a nivel de schema, no de prosa
    expect(parsed.response_format).toBeDefined();
    expect(parsed.response_format.type).toBe('json_schema');
    expect(parsed.response_format.json_schema.strict).toBe(true);

    const schema = parsed.response_format.json_schema.schema;
    expect(schema.required).toEqual(['general_1', 'general_2', 'especifico_1', 'especifico_2', 'especifico_3']);
    expect(schema.additionalProperties).toBe(false);

    // Regla de neutralidad de postura vive en la descripción del schema, no en el rulesText
    expect(schema.description).toContain('filantrocapitalismo');

    // Regla de "no repetir el mismo eje" (ej. argentina / politica-argentina) vive en general_2
    expect(schema.properties.general_2.description).toContain('mismo eje');

    // Regla de unicidad ahora dividida en 2 criterios (mecánico vs. semántico) + auto-verificación
    expect(schema.description).toContain('CRITERIO A');
    expect(schema.description).toContain('CRITERIO B');
    expect(schema.description).toContain('AUTO-VERIFICACIÓN OBLIGATORIA');
    expect(schema.properties.especifico_1.description).toContain('CRITERIO A');

    // Regla anti-reutilización: un valor específico no puede coincidir con lo que serviría como general
    expect(schema.description).toContain('REGLA ANTI-REUTILIZACIÓN');
  });

  it('leaves non-tagging payload buffers completely untouched', () => {
    const normalPayload = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
    };
    const inputBuffer = Buffer.from(JSON.stringify(normalPayload), 'utf-8');
    const outputBuffer = enrichTaggingRequest(inputBuffer, tempTagsPath);

    expect(outputBuffer).toEqual(inputBuffer);
  });

  it('fails safely if canonical tags file does not exist', () => {
    const nonExistentPath = path.join(tempDir, 'does-not-exist.json');
    const taggingPayload = {
      model: 'test-model',
      messages: [
        {
          role: 'user',
          content: 'You are an expert whose responsibility is to help with automatic tagging for a read-it-later/bookmarking app.\n<TEXT_CONTENT>\nText\n</TEXT_CONTENT>',
        },
      ],
    };
    const inputBuffer = Buffer.from(JSON.stringify(taggingPayload), 'utf-8');
    const outputBuffer = enrichTaggingRequest(inputBuffer, nonExistentPath);

    expect(outputBuffer).toEqual(inputBuffer);
  });

  describe('sanitizeTaggingResponse', () => {
    it('flattens the structured 5-field response shape into {"tags": [...]} in kebab-case', () => {
      const llmResponse = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                general_1: 'Politica Argentina',
                general_2: 'Economía',
                especifico_1: 'Ley Ómnibus',
                especifico_2: '  fondo sojero ',
                especifico_3: 'Máximo Kirchner',
              }),
            },
          },
        ],
      };

      const buffer = Buffer.from(JSON.stringify(llmResponse), 'utf-8');
      const sanitized = sanitizeTaggingResponse(buffer);

      const parsed = JSON.parse(sanitized.toString('utf-8'));
      const parsedContent = JSON.parse(parsed.choices[0].message.content);

      // Karakeep solo sabe leer {"tags": [...]} — el shape de 5 campos nunca debe llegarle
      expect(parsedContent).toEqual({
        tags: ['politica-argentina', 'economía', 'ley-ómnibus', 'fondo-sojero', 'máximo-kirchner'],
      });
    });

    it('sanitizes tags in LLM JSON response to strict kebab-case', () => {
      const llmResponse = {
        id: 'chatcmpl-test',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '{"tags": ["Politica Nacional", "  diseño web ", "#machine_learning#", "argentina"]}',
            },
          },
        ],
      };

      const buffer = Buffer.from(JSON.stringify(llmResponse), 'utf-8');
      const sanitized = sanitizeTaggingResponse(buffer);

      const parsed = JSON.parse(sanitized.toString('utf-8'));
      const parsedContent = JSON.parse(parsed.choices[0].message.content);

      expect(parsedContent.tags).toEqual([
        'politica-nacional',
        'diseño-web',
        'machine-learning',
        'argentina',
      ]);
    });

    it('handles markdown codeblocks wrapping the JSON content', () => {
      const llmResponse = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: '```json\n{"tags": ["red social", "base de datos"]}\n```',
            },
          },
        ],
      };

      const buffer = Buffer.from(JSON.stringify(llmResponse), 'utf-8');
      const sanitized = sanitizeTaggingResponse(buffer);

      const parsed = JSON.parse(sanitized.toString('utf-8'));
      const parsedContent = JSON.parse(parsed.choices[0].message.content);

      expect(parsedContent.tags).toEqual(['red-social', 'base-de-datos']);
    });

    it('leaves non-tagging or non-JSON responses untouched', () => {
      const llmResponse = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'This is a summary text, not JSON tags.',
            },
          },
        ],
      };

      const buffer = Buffer.from(JSON.stringify(llmResponse), 'utf-8');
      const sanitized = sanitizeTaggingResponse(buffer);

      expect(sanitized).toEqual(buffer);
    });
  });
});