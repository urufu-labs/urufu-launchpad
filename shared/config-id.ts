/**
 * URU-A08: canonical module identity shared by web + compile-service.
 *
 * ConfigId = keccak256(abi.encode(base, canonicalModuleString)).
 *
 * Deliberately excludes instance parameters and chain — those are init data
 * and deployment scope, not implementation identity. The bytecode is committed
 * separately as `artifactHash`.
 *
 * `canonicalModuleString` produces the exact string the on-chain manifest
 * expects. Format:
 *   * All modules v1: alphabetically-sorted `id.join(',')`.
 *   * ANY module v2+: alphabetically-sorted `${id}@${version}` — the `@N`
 *     suffix forces a fresh hash so a V2 impl can't collide with the retired
 *     V1 hash on the same factory (registerImpl is one-shot).
 *
 * Used by:
 *   * `web/src/lib/modules.ts::configHashFor`
 *   * `compile-service/src/server.ts::computeConfigHash`
 * Any other caller must import from HERE — no re-implementations.
 */
export type ModuleVersionLookup = (moduleId: string) => number | undefined;

export function canonicalModuleString(
  moduleIds: readonly string[],
  versionFor: ModuleVersionLookup,
): string {
  const unique = new Set(moduleIds);
  if (unique.size !== moduleIds.length) {
    throw new Error('DUPLICATE_MODULES: each module id may appear once');
  }

  const versions = moduleIds.map((id) => {
    const version = versionFor(id);
    if (version === undefined) throw new Error(`UNKNOWN_MODULE: ${id}`);
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`BAD_MODULE_VERSION: ${id}@${String(version)}`);
    }
    return { id, version };
  });

  // Preserve the historical v1 hash namespace. Once any selected module is
  // v2+, every module is explicitly version-tagged so mixed compositions
  // cannot collide with a prior v1 implementation.
  const versioned = versions.some((m) => m.version >= 2);
  return versions
    .map((m) => (versioned ? `${m.id}@${m.version}` : m.id))
    .sort((a, b) => a.localeCompare(b))
    .join(',');
}
