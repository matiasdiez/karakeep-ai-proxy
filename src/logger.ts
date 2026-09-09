type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MIN_LEVEL: LogLevel = (process.env['LOG_LEVEL'] as LogLevel) ?? 'info';

function ts(): string {
  return new Date().toISOString();
}

function log(level: LogLevel, prefix: string, msg: string, data?: unknown): void {
  if (LEVELS[level] < LEVELS[MIN_LEVEL]) return;

  const line = `[${ts()}] [${level.toUpperCase()}] [${prefix}] ${msg}`;

  if (data !== undefined) {
    const dataStr = typeof data === 'object' ? JSON.stringify(data) : String(data);
    if (level === 'error') {
      console.error(`${line} ${dataStr}`);
    } else if (level === 'warn') {
      console.warn(`${line} ${dataStr}`);
    } else {
      console.log(`${line} ${dataStr}`);
    }
  } else {
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
}

export function createLogger(prefix: string) {
  return {
    debug: (msg: string, data?: unknown) => log('debug', prefix, msg, data),
    info: (msg: string, data?: unknown) => log('info', prefix, msg, data),
    warn: (msg: string, data?: unknown) => log('warn', prefix, msg, data),
    error: (msg: string, data?: unknown) => log('error', prefix, msg, data),
  };
}

export type Logger = ReturnType<typeof createLogger>;
