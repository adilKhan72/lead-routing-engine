// Bundles each service entrypoint into a single ESM file under dist/, so runtime images need
// no TypeScript tooling and only a minimal node_modules for the few packages kept external.
import { build } from 'esbuild';

const entryPoints = {
  ingest: 'services/ingest/src/main.ts',
  router: 'services/router/src/main.ts',
  'mock-buyer': 'services/mock-buyer/src/main.ts',
  migrate: 'packages/shared/src/db/migrate-cli.ts',
};

await build({
  entryPoints,
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // pg optionally requires pg-native; never installed here.
  external: ['pg-native'],
  // Some bundled CommonJS deps call require(); give ESM output a real one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
