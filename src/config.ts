import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function optionalEnv(name: string, defaultVal: string): string {
  return process.env[name] ?? defaultVal;
}

function optionalInt(name: string, defaultVal: number): number {
  const val = process.env[name];
  if (!val) return defaultVal;
  const n = parseInt(val, 10);
  if (isNaN(n)) throw new Error(`Env var ${name} must be an integer, got: ${val}`);
  return n;
}

function optionalFloat(name: string, defaultVal: number): number {
  const val = process.env[name];
  if (!val) return defaultVal;
  const n = parseFloat(val);
  if (isNaN(n)) throw new Error(`Env var ${name} must be a float, got: ${val}`);
  return n;
}

export interface ProxyConfig {
  port: number;

  groq: {
    apiKey: string;
    baseUrl: string;
    model: string;
    rateLimitRpm: number;
    rateLimitTpm: number;
    rateLimitTpd: number;
    rateLimitRpd: number;
  };

  gemini: {
    apiKey: string;
    baseUrl: string;
    model: string;
    rateLimitRpm: number;
    rateLimitTpm: number;
    rateLimitTpd: number;
    rateLimitRpd: number;
  };

  openrouter: {
    apiKey: string;
    baseUrl: string;
    model: string;
    rateLimitRpm: number;
    rateLimitRpd: number;
  };

  cloudflare: {
    apiToken: string;
    accountId: string;
    baseUrl: string;
    model: string;
    rateLimitRpm: number;
    rateLimitTpd: number; // daily neuron limit
  };

  ollama: {
    baseUrl: string;
    model: string;
  };

  activeHoursStart: string; // "HH:MM"
  activeHoursEnd: string;   // "HH:MM"
  timezone: string;

  queuePersistPath: string | null;
  exhaustionThreshold: number; // 0.0 - 1.0
  waitMaxMs: number;
  enableOllama: boolean;
  providerOrder: string[];
}

export function loadConfig(): ProxyConfig {
  return {
    port: optionalInt('PROXY_PORT', 8080),

    groq: {
      apiKey: requireEnv('GROQ_API_KEY'),
      baseUrl: optionalEnv('GROQ_BASE_URL', 'https://api.groq.com/openai/v1'),
      model: optionalEnv('GROQ_MODEL', 'openai/gpt-oss-20b'),
      rateLimitRpm: optionalInt('GROQ_RATE_LIMIT_RPM', 30),
      rateLimitTpm: optionalInt('GROQ_RATE_LIMIT_TPM', 14400),
      rateLimitTpd: optionalInt('GROQ_RATE_LIMIT_TPD', 200000),
      rateLimitRpd: optionalInt('GROQ_RATE_LIMIT_RPD', 1000),
    },

    gemini: {
      apiKey: requireEnv('GEMINI_API_KEY'),
      baseUrl: optionalEnv('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta/openai'),
      model: optionalEnv('GEMINI_MODEL', 'gemini-flash-lite-latest'),
      rateLimitRpm: optionalInt('GEMINI_RATE_LIMIT_RPM', 15),
      rateLimitTpm: optionalInt('GEMINI_RATE_LIMIT_TPM', 1000000),
      rateLimitTpd: optionalInt('GEMINI_RATE_LIMIT_TPD', 0), // 0 = no daily limit
      rateLimitRpd: optionalInt('GEMINI_RATE_LIMIT_RPD', 1500),
    },

    openrouter: {
      apiKey: requireEnv('OPENROUTER_API_KEY'),
      baseUrl: optionalEnv('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
      model: optionalEnv('OPENROUTER_MODEL', 'nvidia/nemotron-3-super-120b-a12b:free'),
      rateLimitRpm: optionalInt('OPENROUTER_RATE_LIMIT_RPM', 20),
      rateLimitRpd: optionalInt('OPENROUTER_RATE_LIMIT_RPD', 50),
    },

    cloudflare: {
      apiToken: requireEnv('CLOUDFLARE_API_TOKEN'),
      accountId: requireEnv('CLOUDFLARE_ACCOUNT_ID'),
      baseUrl: optionalEnv('CLOUDFLARE_BASE_URL', 'https://api.cloudflare.com/client/v4/accounts'),
      model: optionalEnv('CLOUDFLARE_MODEL', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
      rateLimitRpm: optionalInt('CLOUDFLARE_RATE_LIMIT_RPM', 300),
      rateLimitTpd: optionalInt('CLOUDFLARE_RATE_LIMIT_TPD', 10000),
    },

    ollama: {
      baseUrl: optionalEnv('OLLAMA_BASE_URL', 'http://host.docker.internal:11434/v1'),
      model: optionalEnv('OLLAMA_MODEL', 'qwen2.5:7b'),
    },

    activeHoursStart: optionalEnv('ACTIVE_HOURS_START', '07:00'),
    activeHoursEnd: optionalEnv('ACTIVE_HOURS_END', '22:00'),
    timezone: optionalEnv('TIMEZONE', 'America/Argentina/Buenos_Aires'),

    queuePersistPath: process.env['QUEUE_PERSIST_PATH'] ?? null,
    exhaustionThreshold: optionalFloat('EXHAUSTION_THRESHOLD', 0.80),
    waitMaxMs: optionalInt('WAIT_MAX_MS', 20000),
    enableOllama: process.env['ENABLE_OLLAMA'] !== 'false',
    providerOrder: (optionalEnv('PROVIDER_ORDER', 'groq,gemini,openrouter,cloudflare')).split(',').map(s => s.trim().toLowerCase()),
  };
}
