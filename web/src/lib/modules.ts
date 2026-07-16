import { encodeAbiParameters, keccak256, isAddress, parseEther } from 'viem';

export type BaseType = 'ERC20' | 'ERC721A' | 'ERC1155';

/// Enum values matching Solidity's BaseType.
export const BASE_TYPE_TO_UINT: Record<BaseType, 0 | 1 | 2> = {
  ERC20: 0,
  ERC721A: 1,
  ERC1155: 2,
};

/// UI-facing param types.
///  - 'percent': user types a % (e.g. 5 for 5%), stored as %, encoded as bps (×100) into uint16.
///  - 'eth':     user types a decimal ETH string (e.g. "0.01"), stored as string, encoded via parseEther.
export type ModuleParamType = 'integer' | 'address' | 'string' | 'boolean' | 'percent' | 'eth';

export interface ModuleParamField {
  key: string;
  label: string;
  type: ModuleParamType;
  /// For 'integer' + 'percent' this is in the user-facing unit (blocks / %). Not bps.
  min?: number;
  max?: number;
  /// For 'percent' — how many decimal places the input allows (default 2 → 0.01% resolution).
  step?: number;
  defaultValue?: unknown;
  /// Short one-liner explaining what the value does in plain words.
  description?: string;
}

export type ModuleStatus = 'shipped' | 'planned';
export type ModuleCategory =
  | 'token'
  | 'nft'
  | 'allocation'
  | 'governance'
  | 'hook';

export interface ModuleSpec {
  id: string;
  label: string;
  category: ModuleCategory;
  status: ModuleStatus;
  version: number;
  bases: BaseType[];
  requires: string[];
  incompatibleWith: string[];
  flagged: string | null;
  /// True when the module exposes owner-callable functions that are only
  /// meaningful post-launch (pause/unpause, add-to-allowlist, exempt-from-caps).
  /// Bonding-curve launches auto-renounce ownership, so picking one of these
  /// modules under a curve mechanic would silently disable those functions.
  /// The create page uses this flag to grey the module out in that scenario.
  requiresOwner?: boolean;
  /// True when the module hooks into every ERC-20 transfer to burn or route a
  /// slice of the transfer amount (e.g. FeeOnTransfer). Bonding-curve trading
  /// itself goes through the ERC-20 transfer path — the curve calls
  /// `token.transfer(buyer, amount)` on every buy — so this class of module
  /// would corrupt the curve's math, drain reserves on every trade, and mess up
  /// graduation. The create page blocks these on curve mechanic (users can still
  /// use them on direct-launch, where transfers are user-driven).
  taxesTransfers?: boolean;
  description: string;
  /// Human-readable Solidity ABI signature for the module's initData slice, e.g. `(uint16)`.
  abiEncode: string;
  params: ModuleParamField[];
}

export const MODULES: ModuleSpec[] = [
  {
    id: 'AntiBot',
    label: '✿ bot gate',
    category: 'token',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    requiresOwner: true,
    description:
      "keeps snipers out for the first few blocks. only wallets u trust can grab tokens while the gate is up ~ turns off on its own after the window",
    abiEncode: '(uint16)',
    params: [
      {
        key: 'blockGate',
        label: 'how many blocks?',
        type: 'integer',
        min: 0,
        max: 100,
        defaultValue: 5,
        description: 'each block ≈ 12 sec on eth. 5 is normal ~ higher = safer but ppl wait longer to trade ✿',
      },
    ],
  },
  {
    id: 'FeeOnTransfer',
    label: '✿ tax on trade',
    category: 'token',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    taxesTransfers: true,
    description:
      'every trade pays a small tax. u decide how much gets burned forever (deflation ~) vs sent to a wallet u control',
    abiEncode: '(uint16,uint16,uint16,address)',
    params: [
      {
        key: 'feeBps',
        label: 'tax per trade (%)',
        type: 'percent',
        min: 0.01,
        max: 30,
        defaultValue: 5,
        description: 'how much every trade pays into the tax pool. capped at 30% ~',
      },
      {
        key: 'burnBps',
        label: 'burn slice (%)',
        type: 'percent',
        min: 0,
        max: 100,
        defaultValue: 50,
        description: 'of the tax above, how much gets destroyed forever',
      },
      {
        key: 'treasuryBps',
        label: 'wallet slice (%)',
        type: 'percent',
        min: 0,
        max: 100,
        defaultValue: 50,
        description: 'the rest. burn + wallet must add up to exactly 100 ~',
      },
      {
        key: 'treasury',
        label: 'wallet address',
        type: 'address',
        defaultValue: '0x000000000000000000000000000000000000dEaD',
        description: "where the wallet slice lands. paste ur wallet or a multisig ✿",
      },
    ],
  },
  {
    id: 'OnChainSVG',
    label: '✿ art lives on-chain',
    category: 'nft',
    status: 'shipped',
    version: 1,
    bases: ['ERC721A'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description:
      'each nft gets rendered right on the chain — no ipfs, no server, forever. as long as ethereum exists, ur art exists ~',
    abiEncode: '()',
    params: [],
  },
  {
    id: 'ERC2981Royalty',
    label: '✿ resale royalties',
    category: 'nft',
    status: 'shipped',
    version: 1,
    bases: ['ERC721A'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description:
      "opensea, blur & the rest check ur royalty setting and forward a cut on every resale. enforcement is up to them tho ~",
    abiEncode: '(address,uint96)',
    params: [
      {
        key: 'receiver',
        label: 'royalty wallet',
        type: 'address',
        description: 'where royalties land. u can change this after launch ✿',
      },
      {
        key: 'feeBps',
        label: 'royalty (%)',
        type: 'percent',
        min: 0,
        max: 10,
        defaultValue: 5,
        description: 'what marketplaces send u on every resale. capped at 10%',
      },
    ],
  },
  {
    id: 'AntiWhale',
    label: '✿ whale caps',
    category: 'token',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    requiresOwner: true,
    description:
      'caps how much any wallet can hold + how much can move in one trade. runs for N blocks after launch then turns off ~ so whales cant just camp on ur launch',
    abiEncode: '(uint128,uint128,uint32)',
    params: [
      { key: 'maxWallet', label: 'max per wallet', type: 'eth', description: 'biggest wallet balance allowed while caps are on. in ur token units ~' },
      { key: 'maxTx', label: 'max per trade', type: 'eth', description: 'biggest single transfer allowed while caps are on' },
      { key: 'expireAfterBlocks', label: 'how many blocks?', type: 'integer', min: 0, max: 500_000, defaultValue: 1000, description: '1000 ≈ 3 hrs on eth. after this, caps turn off entirely' },
    ],
  },
  {
    id: 'Votes',
    label: '✿ voteable token',
    category: 'token',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: "makes ur token voteable. holders can delegate voting power to themselves or someone else. u need this if u want a dao later ~",
    abiEncode: '()',
    params: [],
  },
  {
    id: 'Permit',
    label: '✿ gasless approvals',
    category: 'token',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'lets holders approve trades with a signature instead of a whole tx (saves gas). standard on modern tokens ~',
    abiEncode: '()',
    params: [],
  },
  {
    id: 'Pausable',
    label: '✿ emergency pause',
    category: 'token',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: 'u can freeze everyone\'s tokens at any time. ppl see this as centralization ~',
    requiresOwner: true,
    description: "u can freeze all trades whenever. safety net for emergencies but ppl see the freeze switch and get spooked ~ think twice before adding",
    abiEncode: '()',
    params: [],
  },
  {
    id: 'DelayedReveal',
    label: '✿ delayed reveal',
    category: 'nft',
    status: 'shipped',
    version: 1,
    bases: ['ERC721A'],
    requires: [],
    incompatibleWith: ['OnChainSVG'],
    flagged: null,
    description: "art stays hidden til u pull the reveal trigger. every nft shows a placeholder image until u call reveal() ~",
    abiEncode: '(string)',
    params: [
      { key: 'hiddenBaseURI', label: 'placeholder art link', type: 'string', defaultValue: 'ipfs://hidden/', description: 'the image ppl see before reveal. ipfs:// or https:// both work ✿' },
    ],
  },
  {
    id: 'Soulbound',
    label: '✿ soulbound',
    category: 'nft',
    status: 'shipped',
    version: 1,
    bases: ['ERC721A'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'nft can never be transferred after mint. good for badges, memberships, poaps ~ only mint + burn work',
    abiEncode: '()',
    params: [],
  },
  {
    id: 'Refundable',
    label: '✿ refundable mint',
    category: 'nft',
    status: 'shipped',
    version: 1,
    bases: ['ERC721A'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'paid mint with a safety net. buyers can burn their nft within N blocks to get their money back — anti-rug for paid drops ✿',
    abiEncode: '(uint256,uint32)',
    params: [
      { key: 'pricePerToken', label: 'price per nft (ETH)', type: 'eth', description: 'what buyers pay each. type the ETH amount ~' },
      { key: 'refundWindowBlocks', label: 'refund window (blocks)', type: 'integer', min: 1, max: 1_000_000, defaultValue: 43_200, description: '43,200 ≈ 6 days on eth. how long buyers can burn-to-refund' },
    ],
  },
  {
    id: 'Vesting',
    label: '✿ vesting schedule',
    category: 'allocation',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'one wallet, one unlock schedule. tokens unlock linearly from cliff to end date ~ no reserve needed, minted as they vest',
    abiEncode: '(address,uint256,uint64,uint64)',
    params: [
      { key: 'beneficiary', label: 'who gets the tokens', type: 'address', description: 'wallet that receives the vested amount ~' },
      { key: 'totalAmount', label: 'total tokens', type: 'eth', description: 'full amount that vests over the schedule' },
      { key: 'cliffTimestamp', label: 'cliff (unix seconds)', type: 'integer', min: 0, description: 'when unlocks start. use a unix timestamp — date pickers ship soon ~' },
      { key: 'endTimestamp', label: 'end (unix seconds)', type: 'integer', min: 0, description: 'when everything is fully unlocked' },
    ],
  },
  {
    id: 'Airdrop',
    label: '✿ airdrop list',
    category: 'allocation',
    status: 'shipped',
    version: 2,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description:
      'give tokens to a big list of ppl by uploading one hash + total. recipients claim their own share, u dont pay gas for each drop. reserve-backed — no dilution ✿',
    abiEncode: '(bytes32,uint256)',
    params: [
      {
        key: 'merkleRoot',
        label: 'airdrop list hash',
        type: 'string',
        description: '0x… output from ur airdrop tool. all the wallets + amounts collapse into one hash ✿',
      },
      {
        key: 'totalAllocation',
        label: 'total tokens for the drop',
        type: 'eth',
        description:
          'sum of every amount in ur merkle list. these tokens get carved out of ur launch supply and held on the token contract til claimed — no post-launch inflation ~',
      },
    ],
  },
  {
    id: 'Staking',
    label: '✿ staking pool',
    category: 'allocation',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: ['FeeOnTransfer'],
    flagged: null,
    description: 'stake this token to earn more of this token. u fund the reward pool up-front, rewards stream out linearly over the window ~ (doesnt stack with tax-on-trade)',
    abiEncode: '(uint256,uint32)',
    params: [
      { key: 'rewardsTotal', label: 'reward pool (tokens)', type: 'eth', description: "how many tokens ur putting up for the whole staking window" },
      { key: 'durationSeconds', label: 'how long? (seconds)', type: 'integer', min: 1, max: 630_720_000, defaultValue: 2_592_000, description: '2,592,000 = 30 days. how long rewards stream out for' },
    ],
  },
  {
    id: 'LPLocked',
    label: '✿ lp locked forever',
    category: 'hook',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'liquidity gets locked in uniswap forever. no one — not even u — can pull it. classic anti-rug ~ this is why urufu labs exists',
    abiEncode: '()',
    params: [],
  },
  {
    id: 'FeeRedirect',
    label: '✿ swap fee → u',
    category: 'hook',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: ['LPLocked'],
    incompatibleWith: [],
    flagged: null,
    description: 'every uniswap swap sends a slice of the output to ur wallet (creator) and a slice to urufu labs. u claim ur fees whenever — max 30% combined',
    abiEncode: '(address,uint16,uint16)',
    params: [
      { key: 'creatorReceiver', label: 'ur wallet', type: 'address', description: 'where ur cut lands. bake it right — this cant change after launch ~' },
      { key: 'platformBps', label: 'urufu cut (%)', type: 'percent', min: 0, max: 30, defaultValue: 1, description: 'what urufu labs takes per swap ~ default 1%' },
      { key: 'creatorBps', label: 'ur cut (%)', type: 'percent', min: 0, max: 30, defaultValue: 1, description: 'what u take per swap. up to 30%' },
    ],
  },
  {
    id: 'AntiSniper',
    label: '✿ sniper gate',
    category: 'hook',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'blocks trades on uniswap for the first N blocks after the pool opens. adds + minting still work — only swapping is gated. auto-expires ~',
    abiEncode: '(uint256)',
    params: [
      { key: 'gateBlocks', label: 'how many blocks?', type: 'integer', min: 1, max: 100_000, defaultValue: 5, description: '5 is normal. higher = more day-0 protection from bots ~' },
    ],
  },
  {
    id: 'MultiHookHost',
    label: '✿ lp lock + swap fee (combo)',
    category: 'hook',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: ['LPLocked', 'FeeRedirect'],
    flagged: null,
    description: 'lp lock and swap fee combined into one. u need this if u want both, bc uniswap only lets one hook attach per pool ~',
    abiEncode: '(address,uint16,uint16)',
    params: [
      { key: 'creatorReceiver', label: 'ur wallet', type: 'address', description: 'where ur cut lands. cant change this after launch ~' },
      { key: 'platformBps', label: 'urufu cut (%)', type: 'percent', min: 0, max: 30, defaultValue: 1, description: 'what urufu labs takes per swap' },
      { key: 'creatorBps', label: 'ur cut (%)', type: 'percent', min: 0, max: 30, defaultValue: 1, description: 'what u take per swap' },
    ],
  },
  {
    id: 'BuybackBurn',
    label: '✿ buy → burn',
    category: 'hook',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'every time someone buys ur token, a slice of the buy gets destroyed. supply shrinks a lil every trade — pure deflation flywheel ~',
    abiEncode: '(uint16)',
    params: [
      { key: 'burnBps', label: 'burn (%)', type: 'percent', min: 0.01, max: 20, defaultValue: 2, description: '0.01% to 20%. slice of every buy that goes straight to dead ~' },
    ],
  },

  // ============================================================
  // ERC-1155 — multi-item drops
  // ============================================================
  {
    id: 'SupplyPerToken1155',
    label: '✿ per-item supply cap',
    category: 'nft',
    status: 'shipped',
    version: 1,
    bases: ['ERC1155'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: "cap how many of each item can exist. items u dont cap stay unlimited ~",
    abiEncode: '(uint256[],uint256[])',
    params: [
      { key: 'ids', label: 'item ids (comma-separated)', type: 'string', description: 'e.g. 1,2,3' },
      { key: 'caps', label: 'max supply per item (comma-separated)', type: 'string', description: 'same order + count as the ids ~' },
    ],
  },
  {
    id: 'PayableMint1155',
    label: '✿ paid mint per item',
    category: 'nft',
    status: 'shipped',
    version: 1,
    bases: ['ERC1155'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'public mint at a fixed price per item. buyers send eth + get the item, u sweep proceeds later ~',
    abiEncode: '(uint256[],uint256[])',
    params: [
      { key: 'ids', label: 'item ids (comma-separated)', type: 'string' },
      { key: 'pricesWei', label: 'prices in wei (comma-separated)', type: 'string', description: 'one price per item, same order as ids. in wei bc these can be huge numbers ~' },
    ],
  },
  {
    id: 'ERC2981Royalty1155',
    label: '✿ resale royalties (1155)',
    category: 'nft',
    status: 'shipped',
    version: 1,
    bases: ['ERC1155'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: "same as the nft royalty module but for multi-item drops. same royalty applies across every item id ~",
    abiEncode: '(address,uint96)',
    params: [
      { key: 'receiver', label: 'royalty wallet', type: 'address', description: 'where royalties land ~' },
      { key: 'feeBps', label: 'royalty (%)', type: 'percent', min: 0, max: 10, defaultValue: 5, description: 'what marketplaces send u on every resale. capped at 10%' },
    ],
  },

  // ============================================================
  // Planned — Base-first compliance tier (B20 lineup)
  // ============================================================
  {
    id: 'B20PolicyAware',
    label: 'B20 — PolicyRegistry aware',
    category: 'token',
    status: 'planned',
    version: 0,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: 'Reduces decentralization — every transfer is gated by an external PolicyRegistry the launcher configures. Same tradeoff as USDC-style compliance layers.',
    description: "Defers every transfer to a Base PolicyRegistry contract. The registry decides whether msg.sender / from / to are allowed to move the token — used for KYC-gated markets, jurisdictional restrictions, and sanctions checks. Base-first (mainnet + Base Sepolia); other chains would need their own PolicyRegistry equivalent.",
    abiEncode: '(address)',
    params: [
      { key: 'policyRegistry', label: 'PolicyRegistry address', type: 'address', description: 'On-chain compliance registry the token will consult on every transfer. Immutable in the deployed token.' },
    ],
  },
  {
    id: 'Blocklist',
    label: 'Blocklist — freeze specific addresses',
    category: 'token',
    status: 'planned',
    version: 0,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: 'Reduces decentralization — owner can freeze arbitrary addresses at any time. Same mechanism USDC + USDT use for sanctions compliance.',
    description: "Owner can block any address from sending or receiving the token. Blocked addresses can still hold their balance but every transfer reverts until they're unblocked. Meant for compliance / sanctions use cases — flagged so launchers know it's a censorship vector.",
    abiEncode: '()',
    params: [],
  },
  {
    id: 'Jailable',
    label: 'Jailable — recover seized funds',
    category: 'token',
    status: 'planned',
    version: 0,
    bases: ['ERC20'],
    requires: ['Blocklist'],
    incompatibleWith: [],
    flagged: 'Reduces decentralization — owner can seize tokens from any address (typically already blocklisted). The strongest censorship primitive we offer.',
    description: "Owner can move tokens out of a blocklisted address into a designated recovery address. Used to reclaim funds from sanctioned wallets or compromised accounts. Requires the Blocklist module — you can only jail tokens from an already-frozen address. Flagged as the strongest censorship primitive.",
    abiEncode: '()',
    params: [],
  },
];

export function modulesForBase(base: BaseType): ModuleSpec[] {
  return MODULES.filter((m) => m.bases.includes(base));
}

export function shippedModulesForBase(base: BaseType): ModuleSpec[] {
  return modulesForBase(base).filter((m) => m.status === 'shipped');
}

export function moduleById(id: string): ModuleSpec | undefined {
  return MODULES.find((m) => m.id === id);
}

/// Client-side config hash. Must exactly match `DeployPhase1.s.sol` formula:
///   keccak256(abi.encode(base, sortedModulesJoinedByComma))
export function configHashFor(base: BaseType, moduleIds: readonly string[]): `0x${string}` {
  const sorted = [...moduleIds].sort((a, b) => a.localeCompare(b));
  const modulesStr = sorted.join(',');
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }],
      [base, modulesStr],
    ),
  );
}

/// Cross-module compatibility check. Returns an array of error strings; empty array = OK.
export function checkCompatibility(selectedIds: readonly string[]): string[] {
  const errors: string[] = [];
  const selected = selectedIds.map((id) => moduleById(id)).filter((m): m is ModuleSpec => !!m);

  for (const mod of selected) {
    for (const req of mod.requires) {
      if (!selectedIds.includes(req)) {
        errors.push(`${mod.id} requires ${req}`);
      }
    }
    for (const incompat of mod.incompatibleWith) {
      if (selectedIds.includes(incompat)) {
        errors.push(`${mod.id} is incompatible with ${incompat}`);
      }
    }
  }
  return errors;
}

/// Basic client-side field validation.
export function validateParam(field: ModuleParamField, value: unknown): string | null {
  if (field.type === 'integer') {
    const n = Number(value);
    if (!Number.isInteger(n)) return `${field.label} must be a whole number`;
    if (field.min !== undefined && n < field.min) return `${field.label} min ${field.min}`;
    if (field.max !== undefined && n > field.max) return `${field.label} max ${field.max}`;
    return null;
  }
  if (field.type === 'percent') {
    const n = Number(value);
    if (!Number.isFinite(n)) return `${field.label} needs a number`;
    if (field.min !== undefined && n < field.min) return `${field.label} min ${field.min}%`;
    if (field.max !== undefined && n > field.max) return `${field.label} max ${field.max}%`;
    return null;
  }
  if (field.type === 'eth') {
    if (typeof value !== 'string' || value.trim().length === 0) return `${field.label} needs an amount`;
    try {
      parseEther(value);
      return null;
    } catch {
      return `${field.label} — bad amount`;
    }
  }
  if (field.type === 'address') {
    if (typeof value !== 'string' || !isAddress(value)) return `${field.label} — paste a valid address`;
    return null;
  }
  return null;
}

/// Convert a user-facing param value to its on-chain encoded form.
///   'percent' → bps  (× 100, rounded)
///   'eth'     → wei  (parseEther)
///   others    → as-is
export function encodeParamValue(field: ModuleParamField, raw: unknown): unknown {
  if (field.type === 'percent') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return 0n;
    return BigInt(Math.round(n * 100));
  }
  if (field.type === 'eth') {
    if (typeof raw !== 'string' || raw.trim().length === 0) return 0n;
    try { return parseEther(raw); } catch { return 0n; }
  }
  return raw;
}
