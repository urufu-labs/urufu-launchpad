import { createPublicClient, getAddress, http, parseAbi, type Address, type Hex } from 'viem';

/// Agent account detection (docs/PLAN-agents-and-swarms.md 2.4): is this wallet a
/// Safe run by an AI agent? Agents trade from their Safe, so this is what lets the
/// site tag their trades and launches. Agents stay anonymous: nothing here needs
/// or returns an owner.
///
/// A wallet counts when, on chain:
///   1. it has code and `getModulesPaginated` answers (a Safe);
///   2. one of its first 10 enabled modules is an EIP-1167 clone of the Zodiac
///      Roles v2 mastercopy (what the agent setup deploys through the
///      ModuleProxyFactory);
///   3. that module's owner() and avatar() are the Safe itself.
/// Same rule as findRolesModule in web/src/lib/agentV2/agentTokenTools.ts, plus
/// the mastercopy check so a Safe with some other Zodiac module isn't tagged.
///
/// Results are cached per address: plain wallets (no code) for a day, contracts
/// for 10 minutes either way, so a module removed later drops the tag. Each read
/// checks at most MAX_NEW_CHECKS uncached addresses, so a long list costs the
/// public RPC little; the rest are checked on the next read.

export const ROLES_V2_MASTERCOPY = '0x9646fDAD06d3e24444381f44362a3B0eB343D337' as Address;
const SENTINEL = '0x0000000000000000000000000000000000000001' as Address;

const safeAbi = parseAbi(['function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)']);
const moduleAbi = parseAbi(['function owner() view returns (address)', 'function avatar() view returns (address)']);

const EOA_TTL_MS = 24 * 60 * 60_000;
const CONTRACT_TTL_MS = 10 * 60_000;
const MAX_CACHE = 50_000;
export const MAX_NEW_CHECKS = 25;
const CONCURRENCY = 4;

export interface AccountChain {
  /// Bytecode at `a`, '0x' for none. Throws on RPC failure.
  code(a: Address): Promise<Hex>;
  /// First page of enabled Safe modules, or null if `a` isn't a Safe.
  modules(a: Address): Promise<Address[] | null>;
  /// owner() and avatar() of a Zodiac module, null on revert.
  ownerAndAvatar(m: Address): Promise<[Address | null, Address | null]>;
}

export function defaultAccountChain(): AccountChain {
  const client = createPublicClient({ transport: http(process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com') });
  const read = (address: Address, abi: typeof moduleAbi, functionName: 'owner' | 'avatar') =>
    client.readContract({ address, abi, functionName }).catch(() => null) as Promise<Address | null>;
  return {
    async code(a) {
      return (await client.getCode({ address: a })) ?? '0x';
    },
    async modules(a) {
      try {
        const page = (await client.readContract({ address: a, abi: safeAbi, functionName: 'getModulesPaginated', args: [SENTINEL, 10n] })) as readonly [readonly Address[], Address];
        return [...page[0]];
      } catch {
        return null;
      }
    },
    ownerAndAvatar: (m) => Promise.all([read(m, moduleAbi, 'owner'), read(m, moduleAbi, 'avatar')]),
  };
}

/// Runtime code of an EIP-1167 minimal proxy pointing at `target`.
export function isMinimalProxyOf(code: Hex, target: Address): boolean {
  return code.toLowerCase() === `0x363d3d373d3d3d363d73${target.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
}

export interface AgentAccount {
  address: string;
  rolesModule: string;
}

export class AgentAccountDetector {
  private cache = new Map<string, { at: number; ttl: number; rolesModule: string | null }>();
  private chain: AccountChain;
  private now: () => number;

  constructor(chain: AccountChain, now: () => number = Date.now) {
    this.chain = chain;
    this.now = now;
  }

  /// The Roles module guarding `a` if it is an agent account, else null.
  async check(a: Address): Promise<string | null> {
    const code = await this.chain.code(a);
    if (code === '0x') return this.remember(a, null, EOA_TTL_MS);
    const mods = await this.chain.modules(a);
    for (const m of mods ?? []) {
      if (!isMinimalProxyOf(await this.chain.code(m), ROLES_V2_MASTERCOPY)) continue;
      const [owner, avatar] = await this.chain.ownerAndAvatar(m);
      if (owner?.toLowerCase() === a.toLowerCase() && avatar?.toLowerCase() === a.toLowerCase()) {
        return this.remember(a, m.toLowerCase(), CONTRACT_TTL_MS);
      }
    }
    return this.remember(a, null, CONTRACT_TTL_MS);
  }

  /// Agent accounts among `wallets` (lower-cased). Uncached addresses beyond
  /// MAX_NEW_CHECKS, and any whose RPC read fails, are left out for now.
  async find(wallets: string[]): Promise<AgentAccount[]> {
    const out: AgentAccount[] = [];
    const todo: string[] = [];
    for (const w of wallets) {
      const hit = this.cache.get(w);
      if (hit && this.now() - hit.at < hit.ttl) {
        if (hit.rolesModule) out.push({ address: w, rolesModule: hit.rolesModule });
      } else if (todo.length < MAX_NEW_CHECKS) {
        todo.push(w);
      }
    }
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const w = todo[next++]!;
        try {
          const m = await this.check(getAddress(w));
          if (m) out.push({ address: w, rolesModule: m });
        } catch {
          // RPC trouble: no tag this time, try again on the next read.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
    return out;
  }

  private remember(a: Address, rolesModule: string | null, ttl: number): string | null {
    if (this.cache.size >= MAX_CACHE) this.cache.clear();
    this.cache.set(a.toLowerCase(), { at: this.now(), ttl, rolesModule });
    return rolesModule;
  }
}
