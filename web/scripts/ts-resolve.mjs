// Node test-runner resolve hook so `node --test` can load lib modules that use
// the app's own import style (`@/lib/x` and extensionless relative imports).
// Next resolves these at build time; plain Node needs this shim.
//
// Usage: node --experimental-strip-types --import ./scripts/ts-resolve.mjs --test ...
import { register } from 'node:module';

register('./ts-resolve-hooks.mjs', import.meta.url);
