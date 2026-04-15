#!/usr/bin/env node
import { build } from 'esbuild';
import { builtinModules } from 'node:module';

// google-auth-library and @google/genai use CJS internally with require()
// calls to Node built-ins. We must externalize these to avoid the
// "Dynamic require of X is not supported" error in ESM bundles.
//
// Strategy: bundle all npm deps INTO the output, but keep Node built-ins external.
// This produces a single file that only depends on Node.js itself + npm deps
// that are already bundled inside.

await build({
  entryPoints: ['src/gemini-companion.ts'],
  outfile: 'dist/gemini-companion.cjs',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  // Keep Node built-ins external (they're available at runtime)
  external: builtinModules.flatMap(m => [m, `node:${m}`]),
});

console.log('Built dist/gemini-companion.cjs');
