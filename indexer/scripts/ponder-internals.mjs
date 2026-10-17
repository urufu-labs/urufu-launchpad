// Node loader hook for scripts/replay-getlogs.ts.
//
// `import ... from 'ponder-internals'` loads the exact compiled file the
// `ponder` CLI runs (@ponder/core/dist/bin/ponder.js), with one change: its
// last line, `await ponder.parseAsync();` (start the CLI), is replaced by an
// export of the internals the sync service uses. The module keeps its real
// URL (plus a query), so all its own imports (viem, @ponder/utils, ...)
// resolve exactly as they do in production.
import { readFileSync, realpathSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SPECIFIER = 'ponder-internals';
const QUERY = '?ponder-internals';
const EXPORTS = [
  'buildConfigAndIndexingFunctions',
  'buildOptions',
  'createHistoricalSync',
  'createLogger',
  'createRequestQueue',
  'MetricsService',
];

let ponderJs;
if (!globalThis.__ponderInternalsRegistered) {
  globalThis.__ponderInternalsRegistered = true;
  const core = realpathSync(fileURLToPath(new URL('../node_modules/@ponder/core', import.meta.url)));
  register(import.meta.url, { data: pathToFileURL(`${core}/dist/bin/ponder.js`).href });
}

export function initialize(data) {
  ponderJs = data;
}

export async function resolve(specifier, context, next) {
  if (specifier === SPECIFIER) return { url: ponderJs + QUERY, shortCircuit: true };
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url !== ponderJs + QUERY) return next(url, context);
  const src = readFileSync(fileURLToPath(ponderJs), 'utf8');
  const cli = 'await ponder.parseAsync();';
  if (!src.includes(cli)) throw new Error(`ponder-internals: '${cli}' not found in ${ponderJs}; Ponder version changed?`);
  return {
    format: 'module',
    source: src.replace(cli, `export { ${EXPORTS.join(', ')} };`),
    shortCircuit: true,
  };
}
