import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { service },
    // Lead payloads carry contact details; never let them reach the logs by accident.
    redact: { paths: ['*.contact', '*.payload', 'req.headers.authorization'], censor: '[redacted]' },
  });
}
