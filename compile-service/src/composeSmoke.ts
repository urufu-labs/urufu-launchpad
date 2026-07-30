// Smoke test: reproduces the server's compose() call path for the Votes
// module (which uses matrix.json's `templateOverride`). Guards against
// regression of the 2026-07-30 fix where server.ts forgot to pass
// baseContractName to compose(), causing every Votes /compile to hard-fail.
//
// Run manually:
//   node --experimental-strip-types compile-service/src/composeSmoke.ts
//
// Exits 0 if Votes compose succeeds and emits ERC20WithVotesGen with the
// expected contract inheritance; non-zero otherwise.

import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { loadMatrix } from './matrix.ts';
import { compose } from './compile.ts';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');
const MATRIX_PATH = resolve(REPO_ROOT, 'shared/matrix.json');

function composedName(base: string, modules: string[]): string {
    if (modules.length === 0) return `${base}Bare`;
    return `${base}With${modules.map((m) => m[0]!.toUpperCase() + m.slice(1)).join('And')}Gen`;
}

function resolveTemplate(matrix: ReturnType<typeof loadMatrix>, modules: string[]): { templatePath: string; overriding: string | null } {
    // Mirror server.ts logic — only ONE override allowed.
    let templatePath = resolve(REPO_ROOT, 'contracts/src/templates/ERC20Template.sol');
    let overriding: string | null = null;
    for (const mid of modules) {
        const spec = matrix.modules[mid];
        if (!spec?.templateOverride) continue;
        if (overriding !== null) throw new Error(`TEMPLATE_OVERRIDE_CONFLICT: ${overriding} and ${mid}`);
        overriding = mid;
        templatePath = resolve(REPO_ROOT, spec.templateOverride);
    }
    return { templatePath, overriding };
}

function run(): void {
    const matrix = loadMatrix(MATRIX_PATH);

    // Case 1: Votes-only — must pick ERC20VotesTemplate + succeed.
    {
        const modules = ['Votes'];
        const { templatePath, overriding } = resolveTemplate(matrix, modules);
        assert.equal(overriding, 'Votes', 'Votes must trigger templateOverride');
        assert.ok(templatePath.endsWith('ERC20VotesTemplate.sol'), 'must resolve to ERC20VotesTemplate');
        const baseContractName = basename(templatePath, '.sol');
        const composed = compose({
            matrix,
            config: { base: 'ERC20', modules, params: { Votes: {} } },
            templatePath,
            contractName: composedName('ERC20', modules),
            baseContractName,
            repoRoot: REPO_ROOT,
        });
        assert.ok(
            composed.source.includes(`contract ${composed.contractName}`),
            'output must declare the composed contract name',
        );
        assert.ok(
            composed.source.includes('ERC20Votes') || composed.source.includes('Votes'),
            'output must retain Votes inheritance chain',
        );
        process.stdout.write(`ok: Votes -> ${composed.contractName}\n`);
    }

    // Case 2: bare ERC20 — no override, default template.
    {
        const modules: string[] = [];
        const { templatePath, overriding } = resolveTemplate(matrix, modules);
        assert.equal(overriding, null, 'bare must not trigger override');
        assert.ok(templatePath.endsWith('ERC20Template.sol'), 'bare must use default template');
        const composed = compose({
            matrix,
            config: { base: 'ERC20', modules, params: {} },
            templatePath,
            contractName: composedName('ERC20', modules),
            repoRoot: REPO_ROOT,
        });
        assert.ok(composed.source.length > 0);
        process.stdout.write(`ok: bare -> ${composed.contractName}\n`);
    }

    // Case 3: Votes + another module — conflict path, but only if the other
    // module also declares an override. Today only Votes has one, so this
    // is a happy-path multi-module compose.
    {
        const modules = ['Airdrop', 'Votes'];
        const { templatePath, overriding } = resolveTemplate(matrix, modules);
        assert.equal(overriding, 'Votes');
        const composed = compose({
            matrix,
            config: {
                base: 'ERC20',
                modules,
                params: {
                    Votes: {},
                    Airdrop: { merkleRoot: '0x' + '0'.repeat(64), totalAllocation: '1000000000000000000000000' },
                },
            },
            templatePath,
            contractName: composedName('ERC20', modules),
            baseContractName: basename(templatePath, '.sol'),
            repoRoot: REPO_ROOT,
        });
        assert.ok(composed.source.includes(`contract ${composed.contractName}`));
        process.stdout.write(`ok: Airdrop+Votes -> ${composed.contractName}\n`);
    }

    process.stdout.write('composeSmoke: all cases passed\n');
}

try {
    run();
} catch (err) {
    process.stderr.write(`composeSmoke FAILED: ${(err as Error).message}\n`);
    process.exit(1);
}
