import { z } from 'zod';
import { createLogger } from '@lre/shared';
import { buildMockBuyer } from './app.ts';

const port = z.coerce.number().int().default(4000).parse(process.env.PORT);
const log = createLogger('mock-buyer');
const app = buildMockBuyer();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port, host: '0.0.0.0' });
log.info({ port }, 'mock buyer listening');
