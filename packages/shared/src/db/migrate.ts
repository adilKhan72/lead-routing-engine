import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Pool } from './pool.ts';

// Arbitrary constant so concurrent migrators (e.g. several pods starting at once) take turns.
const MIGRATION_LOCK_ID = 727_001;

// Resolved from the working directory (repo root locally, /app in the image) so it survives bundling.
export const DEFAULT_MIGRATIONS_DIR = resolve(process.env.MIGRATIONS_DIR ?? 'db/migrations');

/** Applies pending `NNNN_name.sql` files in order, each in its own transaction. Returns applied versions. */
export async function migrate(pool: Pool, dir = DEFAULT_MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const done = new Set(rows.map((r) => r.version));
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (done.has(version)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${version} failed`, { cause: err });
      }
      applied.push(version);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return applied;
}
