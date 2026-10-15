import { createLogger } from '../logger.ts';
import { createPool } from './pool.ts';
import { migrate } from './migrate.ts';

const log = createLogger('migrate');
const url = process.env.DATABASE_URL;
if (!url) {
  log.fatal('DATABASE_URL is required');
  process.exit(1);
}
const pool = createPool(url, 1);
try {
  const applied = await migrate(pool);
  log.info({ applied }, applied.length ? 'migrations applied' : 'schema up to date');
} finally {
  await pool.end();
}
