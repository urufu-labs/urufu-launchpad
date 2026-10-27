// Resolve hooks registered by ts-resolve.mjs. Maps `@/x` to `web/src/x` and adds a
// `.ts` / `.tsx` / `/index.ts` suffix to extensionless relative or aliased imports.
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const SUFFIXES = ['.ts', '.tsx', '/index.ts'];

function tryFile(base) {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const s of SUFFIXES) if (existsSync(base + s)) return base + s;
  return null;
}

export async function resolve(specifier, context, next) {
  let base = null;
  if (specifier.startsWith('@/')) {
    base = join(SRC, specifier.slice(2));
  } else if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
    base = join(dirname(fileURLToPath(context.parentURL)), specifier);
  }
  if (base) {
    const hit = tryFile(base);
    if (hit) return next(pathToFileURL(hit).href, context);
  }
  return next(specifier, context);
}
