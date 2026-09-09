export enum ProviderName {
  GROQ = 'groq',
  GEMINI = 'gemini',
  OPENROUTER = 'openrouter',
  CLOUDFLARE = 'cloudflare',
  OLLAMA = 'ollama',
}

export interface RateLimitStats {
  used: number;
  limit: number;
  pct: number;
}

export interface ProviderStats {
  name: ProviderName;
  exhausted: boolean;
  exhaustedAt: number | null;
  rpm: RateLimitStats;
  tpm: RateLimitStats | null; // null if no token-per-minute limit
  tpd: RateLimitStats | null; // null if no daily token limit
  rpd: RateLimitStats | null; // null if no daily request limit
}

export interface QueuedRequest {
  id: string;
  timestamp: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  retries: number;
}
