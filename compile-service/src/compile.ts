import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { CompileConfig, Matrix } from './matrix.ts';
import { validateConfig } from './matrix.ts';

/// A fragment section body extracted from a `.frag.sol` file.
export interface Fragment {
  moduleId: string;
  version: number;
  bases: string[];
  requires: string[];
  incompatibleWith: string[];
  flagged: string | null;
  sections: Map<string, string>; // markerId (e.g. VM_INJECT_STATE) → body
}

/// Parse a fragment file. See docs/SPEC-modules.md §Fragment file format.
export function parseFragment(fragmentPath: string): Fragment {
  const raw = readFileSync(resolve(fragmentPath), 'utf8');
  const lines = raw.split(/\r?\n/);

  const header: Record<string, string> = {};
  const sections = new Map<string, string>();

  let i = 0;
  // Header pass: `// VM_MODULE_X: value` lines at the top of the file.
  for (; i < lines.length; ++i) {
    const line = lines[i]!;
    const headerMatch = line.match(/^\/\/ VM_MODULE_(\w+):\s*(.*)$/);
    if (headerMatch) {
      header[headerMatch[1]!] = headerMatch[2]!.trim();
      continue;
    }
    if (line.match(/^\/\/ SECTION:\s*VM_INJECT_/)) break;
  }

  // Section pass: SECTION markers introduce bodies that run to the next SECTION or EOF.
  let currentSection: string | null = null;
  let buffer: string[] = [];
  for (; i < lines.length; ++i) {
    const line = lines[i]!;
    const sectionMatch = line.match(/^\/\/ SECTION:\s*(VM_INJECT_\w+)\s*$/);
    if (sectionMatch) {
      if (currentSection) {
        sections.set(currentSection, buffer.join('\n').trim());
      }
      currentSection = sectionMatch[1]!;
      buffer = [];
      continue;
    }
    // Skip divider comment lines that flank SECTION headers.
    if (line.match(/^\/\/ =+$/)) continue;
    buffer.push(line);
  }
  if (currentSection) {
    sections.set(currentSection, buffer.join('\n').trim());
  }

  const moduleId = header['ID'];
  if (!moduleId) throw new Error(`fragment ${fragmentPath}: missing VM_MODULE_ID header`);

  return {
    moduleId,
    version: Number(header['VERSION'] ?? 0),
    bases: (header['BASES'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    requires: (header['REQUIRES'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    incompatibleWith: (header['INCOMPATIBLE_WITH'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    flagged: header['FLAGGED']?.trim() || null,
    sections,
  };
}

/// Splice a template's `// VM_INJECT_X` markers with each module's corresponding section body,
/// alphabetically ordered by moduleId. Same input always produces same output.
export function splice(templateSource: string, fragments: Fragment[]): string {
  const sorted = [...fragments].sort((a, b) => a.moduleId.localeCompare(b.moduleId));

  const markerBodies = new Map<string, string[]>();
  for (let idx = 0; idx < sorted.length; ++idx) {
    const f = sorted[idx]!;
    for (const [markerId, body] of f.sections) {
      if (body.length === 0) continue;

      // In VM_INJECT_INIT sections, rewrite `moduleData` (as a standalone identifier) to
      // `moduleData[<idx>]` so each module reads its own slice of the `bytes[]` array.
      // Other sections don't reference module data — no rewrite needed.
      let processedBody = body;
      if (markerId === 'VM_INJECT_INIT') {
        processedBody = body.replace(/\bmoduleData\b/g, `moduleData[${idx}]`);
      }

      let arr = markerBodies.get(markerId);
      if (!arr) {
        arr = [];
        markerBodies.set(markerId, arr);
      }
      arr.push(`// --- from ${f.moduleId}.frag.sol ---\n${processedBody}`);
    }
  }

  let out = templateSource;
  for (const [markerId, bodies] of markerBodies) {
    const combined = bodies.join('\n\n');
    // Match a line whose only non-whitespace content is `// VM_INJECT_X`.
    // Preserve leading indentation to keep the injected body syntactically consistent.
    const markerRegex = new RegExp(`^([ \\t]*)\\/\\/ ${markerId}\\s*$`, 'm');
    if (!markerRegex.test(out)) {
      throw new Error(`template missing marker: ${markerId}`);
    }
    out = out.replace(markerRegex, (_full, indent: string) => {
      const indented = combined
        .split('\n')
        .map((l) => (l.length === 0 ? l : `${indent}${l}`))
        .join('\n');
      return `${indent}// ${markerId}\n${indented}`;
    });
  }

  return out;
}

export interface CompileInput {
  matrix: Matrix;
  config: CompileConfig;
  templatePath: string;
  contractName: string; // name of the generated contract in the output .sol
  repoRoot: string;     // absolute path to the repo root (fragmentPaths are resolved relative to this)
  /// Original contract name declared in the template file. Defaults to `<Base>Template`
  /// (e.g. `ERC20Template`, `ERC721ATemplate`). Splicer uses this to rewrite `contract <baseName>`
  /// to `contract <contractName>`.
  baseContractName?: string;
}

export interface CompileOutput {
  contractName: string;
  source: string;
  moduleIds: string[]; // sorted, deterministic
}

/// Full compose pass: validate → load template → load fragments → splice → rename contract.
export function compose(input: CompileInput): CompileOutput {
  validateConfig(input.matrix, input.config);

  let template = readFileSync(resolve(input.templatePath), 'utf8');

  const fragments: Fragment[] = [];
  for (const mid of input.config.modules) {
    const spec = input.matrix.modules[mid];
    if (!spec) throw new Error(`UNKNOWN_MODULE: ${mid}`); // validate should catch, but belt-and-braces
    const fragPath = resolve(input.repoRoot, spec.fragmentPath);
    fragments.push(parseFragment(fragPath));
  }

  let source = splice(template, fragments);

  // Rename the contract from the template's original name to the composed name.
  // Matches `contract ERC20Template ` → `contract <contractName> `.
  const baseName = input.baseContractName ?? `${input.config.base}Template`;
  const renameRegex = new RegExp(`\\bcontract ${baseName}\\b`);
  if (!renameRegex.test(source)) {
    throw new Error(`template does not declare contract ${baseName}: ${input.templatePath}`);
  }
  source = source.replace(renameRegex, `contract ${input.contractName}`);

  const moduleIds = fragments.map((f) => f.moduleId).sort();
  return { contractName: input.contractName, source, moduleIds };
}
