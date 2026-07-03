import { encodeAbiParameters, keccak256, isAddress } from 'viem';

export type BaseType = 'ERC20' | 'ERC721A' | 'ERC1155';

/// Enum values matching Solidity's BaseType.
export const BASE_TYPE_TO_UINT: Record<BaseType, 0 | 1 | 2> = {
  ERC20: 0,
  ERC721A: 1,
  ERC1155: 2,
};

export type ModuleParamType = 'integer' | 'address' | 'string' | 'boolean';

export interface ModuleParamField {
  key: string;
  label: string;
  type: ModuleParamType;
  min?: number;
  max?: number;
  defaultValue?: unknown;
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
  description: string;
  /// Human-readable Solidity ABI signature for the module's initData slice, e.g. `(uint16)`.
  abiEncode: string;
  params: ModuleParamField[];
}

export const MODULES: ModuleSpec[] = [
  {
    id: 'AntiBot',
    label: 'Anti-bot block gate',
    category: 'token',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description:
      'Blocks non-allowlisted recipients from receiving the token for N blocks after launch. Owner can allowlist wallets. Sender-owner is always exempt.',
    abiEncode: '(uint16)',
    params: [
      {
        key: 'blockGate',
        label: 'Block gate',
        type: 'integer',
        min: 0,
        max: 100,
        defaultValue: 5,
        description:
          'Number of blocks post-launch during which transfers to non-allowlisted addresses revert.',
      },
    ],
  },
  {
    id: 'FeeOnTransfer',
    label: 'Fee on transfer',
    category: 'token',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description:
      'Take a percentage of every transfer and split between burn and treasury. Recipient effectively receives (amount − fee).',
    abiEncode: '(uint16,uint16,uint16,address)',
    params: [
      {
        key: 'feeBps',
        label: 'Fee (bps)',
        type: 'integer',
        min: 1,
        max: 3_000,
        defaultValue: 500,
        description: '100 bps = 1%. Capped at 30%.',
      },
      {
        key: 'burnBps',
        label: 'Burn split (bps)',
        type: 'integer',
        min: 0,
        max: 10_000,
        defaultValue: 5_000,
        description: 'Portion of fee that gets burned. Burn + treasury must sum to 10 000.',
      },
      {
        key: 'treasuryBps',
        label: 'Treasury split (bps)',
        type: 'integer',
        min: 0,
        max: 10_000,
        defaultValue: 5_000,
      },
      {
        key: 'treasury',
        label: 'Treasury address',
        type: 'address',
        defaultValue: '0x000000000000000000000000000000000000dEaD',
      },
    ],
  },
  {
    id: 'OnChainSVG',
    label: 'On-chain SVG',
    category: 'nft',
    status: 'shipped',
    version: 1,
    bases: ['ERC721A'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description:
      'Renders each token as a base64-encoded SVG stored fully on-chain. No IPFS, no external hosting.',
    abiEncode: '()',
    params: [],
  },
  {
    id: 'ERC2981Royalty',
    label: 'ERC-2981 royalty',
    category: 'nft',
    status: 'shipped',
    version: 1,
    bases: ['ERC721A'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description:
      'Standard ERC-2981 royalty. Marketplaces (OpenSea, Blur, Magic Eden) query royaltyInfo and forward the reported percentage on secondary sales. Enforcement is off-chain.',
    abiEncode: '(address,uint96)',
    params: [
      {
        key: 'receiver',
        label: 'Royalty receiver',
        type: 'address',
        description: 'Address that receives royalties. Owner can rotate post-launch.',
      },
      {
        key: 'feeBps',
        label: 'Royalty (bps)',
        type: 'integer',
        min: 0,
        max: 1_000,
        defaultValue: 500,
        description: '100 bps = 1%. Capped at 10%.',
      },
    ],
  },

  // ============================================================
  // Planned — SPEC'd but not yet spliced. Shown greyed-out in the catalog + picker.
  // Params + abiEncode are informational; will be finalized when the fragment ships.
  // ============================================================
  {
    id: 'AntiWhale',
    label: 'Anti-whale caps',
    category: 'token',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'Per-tx cap + per-wallet cap enforced for N blocks after launch. Auto-expires. Owner is exempt.',
    abiEncode: '(uint128,uint128,uint32)',
    params: [
      { key: 'maxWallet', label: 'Max wallet (wei)', type: 'string', description: 'Absolute cap on any wallet balance. Enter in wei (18 decimals).' },
      { key: 'maxTx', label: 'Max tx (wei)', type: 'string', description: 'Absolute cap on any single transfer amount. In wei.' },
      { key: 'expireAfterBlocks', label: 'Expire after N blocks', type: 'integer', min: 0, max: 500_000, defaultValue: 1000, description: 'After this many blocks post-launch, caps stop applying entirely.' },
    ],
  },
  {
    id: 'Votes',
    label: 'ERC-20 Votes',
    category: 'token',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'Solady ERC20Votes — checkpointed delegation compatible with ERC-5805 governors. Required for the governance bundle. Selecting this switches the base template.',
    abiEncode: '()',
    params: [],
  },
  {
    id: 'Permit',
    label: 'ERC-2612 Permit',
    category: 'token',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'Gasless approvals via EIP-712 signatures. Standard on most modern ERC-20s.',
    abiEncode: '()',
    params: [],
  },
  {
    id: 'Pausable',
    label: 'Pausable transfers',
    category: 'token',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: 'Reduces decentralization — owner can halt all transfers.',
    description: 'Owner can pause all non-owner transfers. Mint / burn / owner sends still work. Flagged as a censorship vector.',
    abiEncode: '()',
    params: [],
  },
  {
    id: 'DelayedReveal',
    label: 'Delayed reveal',
    category: 'nft',
    status: 'shipped',
    version: 1,
    bases: ['ERC721A'],
    requires: [],
    incompatibleWith: ['OnChainSVG'],
    flagged: null,
    description: 'Hidden URI until owner calls reveal(). Pre-reveal every token points at the placeholder + id; post-reveal at the real base URI.',
    abiEncode: '(string)',
    params: [
      { key: 'hiddenBaseURI', label: 'Hidden base URI', type: 'string', defaultValue: 'ipfs://hidden/', description: 'URI prefix served for every token until reveal is called.' },
    ],
  },
  {
    id: 'Soulbound',
    label: 'Soulbound',
    category: 'nft',
    status: 'shipped',
    version: 1,
    bases: ['ERC721A'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'Non-transferable after mint. Every user-to-user transfer reverts; only mint and burn work. Owner cannot bypass.',
    abiEncode: '()',
    params: [],
  },
  {
    id: 'Refundable',
    label: 'Refundable mint',
    category: 'nft',
    status: 'shipped',
    version: 1,
    bases: ['ERC721A'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'Public payable mint. Buyer can burn each token within N blocks post-mint to reclaim its price. Owner sweeps expired funds. Anti-rug primitive for paid drops.',
    abiEncode: '(uint256,uint32)',
    params: [
      { key: 'pricePerToken', label: 'Price per token (wei)', type: 'string', description: 'Amount buyer sends per token. Enter in wei.' },
      { key: 'refundWindowBlocks', label: 'Refund window (blocks)', type: 'integer', min: 1, max: 1_000_000, defaultValue: 43_200, description: 'Blocks after mint during which buyer can burn to refund.' },
    ],
  },
  {
    id: 'Vesting',
    label: 'Vesting schedule',
    category: 'allocation',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'Single-beneficiary linear vesting from cliff to end. Tokens are lazy-minted on release — no reserve needed at launch.',
    abiEncode: '(address,uint256,uint64,uint64)',
    params: [
      { key: 'beneficiary', label: 'Beneficiary', type: 'address' },
      { key: 'totalAmount', label: 'Total amount (wei)', type: 'string' },
      { key: 'cliffTimestamp', label: 'Cliff (unix seconds)', type: 'integer', min: 0 },
      { key: 'endTimestamp', label: 'End (unix seconds)', type: 'integer', min: 0 },
    ],
  },
  {
    id: 'Airdrop',
    label: 'Merkle airdrop',
    category: 'allocation',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'Community airdrop via merkle proof claim. Root is provided at launch; recipients claim their leaf amount on their own schedule.',
    abiEncode: '(bytes32)',
    params: [
      {
        key: 'merkleRoot',
        label: 'Merkle root',
        type: 'string',
        description: 'Off-chain root over (recipient, amount) leaves. Leaf format: keccak256(abi.encodePacked(recipient, amount)).',
      },
    ],
  },
  {
    id: 'Staking',
    label: 'Staking pool',
    category: 'allocation',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: ['FeeOnTransfer'],
    flagged: null,
    description: 'Inline single-asset staking. Users stake the token itself; rewards (in the same token) accrue linearly over the emission window. Not compatible with FeeOnTransfer.',
    abiEncode: '(uint256,uint32)',
    params: [
      { key: 'rewardsTotal', label: 'Rewards pool (wei)', type: 'string', description: 'Total token rewards distributed over the window.' },
      { key: 'durationSeconds', label: 'Duration (seconds)', type: 'integer', min: 1, max: 630_720_000, defaultValue: 2_592_000 },
    ],
  },
  {
    id: 'GovernorBundle',
    label: 'Governor + Timelock',
    category: 'governance',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: ['Votes'],
    incompatibleWith: [],
    flagged: null,
    description: 'Deploys an OpenZeppelin Governor + TimelockController at launch, wired to this token as the votes source. Ready for proposals immediately.',
    abiEncode: '(uint48,uint32,uint256,uint256,uint256)',
    params: [
      { key: 'votingDelay', label: 'Voting delay (seconds)', type: 'integer', min: 0, defaultValue: 86_400 },
      { key: 'votingPeriod', label: 'Voting period (seconds)', type: 'integer', min: 60, defaultValue: 604_800 },
      { key: 'proposalThreshold', label: 'Proposal threshold (wei)', type: 'string' },
      { key: 'quorumNumerator', label: 'Quorum (%)', type: 'integer', min: 1, max: 100, defaultValue: 4 },
      { key: 'timelockMinDelay', label: 'Timelock delay (seconds)', type: 'integer', min: 0, defaultValue: 172_800 },
    ],
  },
  {
    id: 'LPLocked',
    label: 'Uniswap v4 — LP locked',
    category: 'hook',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'Uniswap v4 hook that reverts every remove-liquidity call — LP minted to a pool with this hook is locked forever. Requires the deployer to CREATE2-mine an address whose low bits set BEFORE_REMOVE_LIQUIDITY_FLAG.',
    abiEncode: '()',
    params: [],
  },
  {
    id: 'FeeRedirect',
    label: 'Uniswap v4 — Fee redirect',
    category: 'hook',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: ['LPLocked'],
    incompatibleWith: [],
    flagged: null,
    description: 'v4 hook that takes a bps slice of every swap output and routes it to platform (protocol treasury) + your creator address. Recipients sweep accumulated fees via claim(currency). Total redirect capped at 30%.',
    abiEncode: '(address,uint16,uint16)',
    params: [
      { key: 'creatorReceiver', label: 'Creator receiver (address)', type: 'address', description: 'Where your creator fees go. Usually your launcher wallet or a multisig. Editable post-launch is NOT possible — this address is immutable in the hook contract.' },
      { key: 'platformBps', label: 'Platform (bps)', type: 'integer', min: 0, max: 3_000, defaultValue: 100, description: '100 bps = 1% of every swap. Goes to urufu labs treasury.' },
      { key: 'creatorBps', label: 'Creator (bps)', type: 'integer', min: 0, max: 3_000, defaultValue: 100, description: '100 bps = 1% of every swap. Goes to your creator receiver.' },
    ],
  },
  {
    id: 'AntiSniper',
    label: 'Uniswap v4 — Anti-sniper',
    category: 'hook',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'v4 hook that blocks all swaps for N blocks after pool init. Day-0 bot protection — LP + minting still work during the gate. Auto-expires after the window.',
    abiEncode: '(uint256)',
    params: [
      { key: 'gateBlocks', label: 'Gate window (blocks)', type: 'integer', min: 1, max: 100_000, defaultValue: 5 },
    ],
  },
  {
    id: 'MultiHookHost',
    label: 'Uniswap v4 — LP lock + fee split (combined)',
    category: 'hook',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: ['LPLocked', 'FeeRedirect'],
    flagged: null,
    description: 'Single hook contract combining LPLocked + FeeRedirect. Required if you want both on the same pool — v4 only allows one hook address per pool. Use this instead of stacking the individual hooks.',
    abiEncode: '(address,uint16,uint16)',
    params: [
      { key: 'creatorReceiver', label: 'Creator receiver (address)', type: 'address', description: 'Where your creator fees go. Usually your launcher wallet or a multisig. Immutable in the hook once deployed.' },
      { key: 'platformBps', label: 'Platform (bps)', type: 'integer', min: 0, max: 3_000, defaultValue: 100, description: '100 bps = 1% of every swap. Goes to urufu labs treasury.' },
      { key: 'creatorBps', label: 'Creator (bps)', type: 'integer', min: 0, max: 3_000, defaultValue: 100, description: '100 bps = 1% of every swap. Goes to your creator receiver.' },
    ],
  },
  {
    id: 'BuybackBurn',
    label: 'Uniswap v4 — Buyback + burn',
    category: 'hook',
    status: 'shipped',
    version: 1,
    bases: ['ERC20'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'v4 hook that skims a bps slice of every swap whose OUTPUT is the launched token and routes it straight to the dead address. Deflationary flywheel — every trade shrinks circulating supply. Capped at 20%.',
    abiEncode: '(uint16)',
    params: [
      { key: 'burnBps', label: 'Burn (bps)', type: 'integer', min: 1, max: 2_000, defaultValue: 200 },
    ],
  },

  // ============================================================
  // ERC-1155 — multi-item drops
  // ============================================================
  {
    id: 'SupplyPerToken1155',
    label: 'Per-token supply cap',
    category: 'nft',
    status: 'shipped',
    version: 1,
    bases: ['ERC1155'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'Declare a hard supply ceiling per token ID at init. Every mint checks the running total against the cap and reverts if exceeded. Ids without a cap stay unlimited (bare-template behavior).',
    abiEncode: '(uint256[],uint256[])',
    params: [
      { key: 'ids', label: 'Token IDs (comma-separated)', type: 'string', description: 'IDs to cap. Example: 1,2,3' },
      { key: 'caps', label: 'Max supply per ID (comma-separated)', type: 'string', description: 'Equal-length with IDs.' },
    ],
  },
  {
    id: 'PayableMint1155',
    label: 'Payable mint per token',
    category: 'nft',
    status: 'shipped',
    version: 1,
    bases: ['ERC1155'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'Public payable mint at a fixed price per token ID. Buyers call mintPayable(id, amount) with msg.value = price × amount. Proceeds accumulate on the contract; owner withdraws via withdrawPayable(address).',
    abiEncode: '(uint256[],uint256[])',
    params: [
      { key: 'ids', label: 'Token IDs (comma-separated)', type: 'string' },
      { key: 'pricesWei', label: 'Prices in wei (comma-separated)', type: 'string', description: 'Equal-length with IDs. Enter in wei.' },
    ],
  },
  {
    id: 'ERC2981Royalty1155',
    label: 'ERC-2981 royalty (1155)',
    category: 'nft',
    status: 'shipped',
    version: 1,
    bases: ['ERC1155'],
    requires: [],
    incompatibleWith: [],
    flagged: null,
    description: 'Uniform royalty across every token ID in the collection. Marketplaces query royaltyInfo(id, salePrice) and forward the reported percentage on secondary sales. Same shape as the ERC-721A variant.',
    abiEncode: '(address,uint96)',
    params: [
      { key: 'receiver', label: 'Royalty receiver', type: 'address' },
      { key: 'feeBps', label: 'Royalty (bps)', type: 'integer', min: 0, max: 1_000, defaultValue: 500, description: '100 bps = 1%. Capped at 10%.' },
    ],
  },

  // ============================================================
  // Planned — Base-first compliance tier (B20 lineup)
  // These modules integrate with Coinbase's B20 PolicyRegistry pattern on Base + Base
  // Sepolia. They're compliance-oriented (KYC-gated transfers, sanctions freezes, seized-
  // funds recovery), the opposite of the permissionless memecoin default. Flagged so
  // launchers explicitly opt into the centralization tradeoff. Ship targets are: after
  // Sepolia broadcast is stable + Base multichain wiring lands.
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
    if (!Number.isInteger(n)) return `${field.label} must be an integer`;
    if (field.min !== undefined && n < field.min) return `${field.label} minimum ${field.min}`;
    if (field.max !== undefined && n > field.max) return `${field.label} maximum ${field.max}`;
    return null;
  }
  if (field.type === 'address') {
    if (typeof value !== 'string' || !isAddress(value)) return `${field.label} must be a valid address`;
    return null;
  }
  return null;
}
