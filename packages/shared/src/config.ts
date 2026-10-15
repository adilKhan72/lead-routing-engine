import { z } from 'zod';

const BaseEnv = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

/** Parses `env` with the base schema extended by `extra`; throws a readable error listing every bad variable. */
export function loadConfig<T extends z.ZodRawShape>(extra: T, env: NodeJS.ProcessEnv = process.env) {
  const result = BaseEnv.extend(extra).safeParse(env);
  if (!result.success) {
    throw new Error(`invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
