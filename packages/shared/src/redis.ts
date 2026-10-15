import { Redis } from 'ioredis';

export type { Redis };

export function createRedis(url: string): Redis {
  // Fail commands fast while disconnected instead of queueing them unboundedly.
  return new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: true, lazyConnect: false });
}
