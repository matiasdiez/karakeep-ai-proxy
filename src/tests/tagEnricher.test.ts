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

  it('enriches tagging prompt with 2-level structure and stance-neutrality rules', () => {
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

    // Estructura de 2 niveles con cupos fijos (2 general + 3 específicas)
    expect(enrichedContent).toContain('ESTRUCTURA EN 2 NIVELES OBLIGATORIA');
    expect(enrichedContent).toContain('NIVEL GENERAL (exactamente 2 etiquetas)');
    expect(enrichedContent).toContain('NIVEL ESPECÍFICO (exactamente 3 etiquetas)');

    // La regla de "concepto ya cubierto" no debe eximir del nivel específico
    expect(enrichedContent).toContain('nunca te exime de generar las 3 etiquetas específicas del nivel 2');

    // Test de unicidad: una etiqueta específica no puede ser un nombre recurrente sin acompañar de lo puntual
    expect(enrichedContent).toContain('TEST DE UNICIDAD');
    expect(enrichedContent).toContain('serviría igual para decenas de artículos distintos');

    // Regla de neutralidad de postura
    expect(enrichedContent).toContain('NEUTRALIDAD DE POSTURA');
    expect(enrichedContent).toContain('filantrocapitalismo');
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

    it('truncates to 5 tags when the model returns more', () => {
      const llmResponse = {
        choices: [{ message: { content: '{"tags": ["a", "b", "c", "d", "e", "f", "g"]}' } }],
      };
      const buffer = Buffer.from(JSON.stringify(llmResponse), 'utf-8');
      const sanitized = sanitizeTaggingResponse(buffer);

      const parsed = JSON.parse(sanitized.toString('utf-8'));
      const parsedContent = JSON.parse(parsed.choices[0].message.content);
      expect(parsedContent.tags).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('passes through as-is (without inventing tags) when the model returns fewer than 5', () => {
      const llmResponse = {
        choices: [{ message: { content: '{"tags": ["a", "b"]}' } }],
      };
      const buffer = Buffer.from(JSON.stringify(llmResponse), 'utf-8');
      const sanitized = sanitizeTaggingResponse(buffer);

      const parsed = JSON.parse(sanitized.toString('utf-8'));
      const parsedContent = JSON.parse(parsed.choices[0].message.content);
      expect(parsedContent.tags).toEqual(['a', 'b']);
    });

    it('invokes onTagCount with the raw (pre-truncation) count for each tagging response found', () => {
      const llmResponse = {
        choices: [{ message: { content: '{"tags": ["a", "b", "c", "d", "e", "f"]}' } }],
      };
      const buffer = Buffer.from(JSON.stringify(llmResponse), 'utf-8');

      const counts: number[] = [];
      sanitizeTaggingResponse(buffer, (count) => counts.push(count));

      expect(counts).toEqual([6]);
    });

    it('does not call onTagCount for a response with no tags array', () => {
      const llmResponse = { choices: [{ message: { content: 'not json tags' } }] };
      const buffer = Buffer.from(JSON.stringify(llmResponse), 'utf-8');

      const counts: number[] = [];
      sanitizeTaggingResponse(buffer, (count) => counts.push(count));

      expect(counts).toEqual([]);
    });
  });
});
