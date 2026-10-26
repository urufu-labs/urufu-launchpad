// Fake dependencies for the agent v2 tests: an in-memory "chain" answering the
// reads the tools make, plus an indexer, metadata store and pin service.
// Addresses below are the live Robinhood ones so parity tests can reuse them.

import { checkDataUrl } from './safeFetch.ts';

export const BOOK = {
  Router: '0xb41e0Bd37D4EF19A7bd2cCEacc13CbbcD8339269',
  NameRegistry: '0x965Aa2420635Ca0431888c6752b9aE8Bbe8d1F05',
  CurveFactory: '0xEC96D023426167e68598FF9ea946882b7f0AE91f',
  MultiHookHost: '0x83d6fa59BEF503112887b16277CF559fDC93E0C4',
  Graduator: '0xB5aA5Fb4863Fe11ea7BdD6Deaf44004A09BD0C23',
  V4SwapRouter: '0xDb3D1C43225faEe04551b663E5aA0969937beEa4',
  PoolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  StateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  FairLaunchFactory: '0x986BFC6c7be4b8d613FC3d25c6633eD9af27701d',
  FairHookHost: '0xDdc9A293cfDd6A824DbD33C58A9e78FEE85828C4',
  NftLaunchFactory: '0x6B90670a3Af0EBc0D12e006Fe25C07160e3F9486',
  Dn404LaunchFactory: '0x3026C71eB13C599BAd0e7a687689D20F8c37A64B',
  Dn404CurveFactory: '0xFa8C3E10F81355059343f684f7268F1E7a8Df24a',
  URU: '0x9fbe210007dDd8389f98d0253018e65CC48b9D24',
  UruWethPoolId: '0xd307e8754c65c451ca726c4549917b3f5765cce16a76f35a6d19aaf7bc230284',
  uruIsCurrency1: true,
  FeeSplitter: '0x60835C422a3671b5F01E6806Fd96b27c90941C83',
  LoyaltyOracle: '0xDcAd73EB96Bd0573b6ed0Ac3FFA32b1A7e0C0b52',
  Erc8004IdentityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
};

export const LAUNCHER = '0x1111111111111111111111111111111111111111';
export const TOKEN = '0x2222222222222222222222222222222222222222';
export const CURVE = '0x3333333333333333333333333333333333333333';
export const BATCH = '0x4444444444444444444444444444444444444444';
export const E18 = 10n ** 18n;

/// Chain state the fake client answers from. Tests override fields per case.
export function defaultChain() {
  return {
    block: 100n,
    paused: false,
    erc20Fee: 1_000_000_000_000_000n, // 0.001 ETH
    quoteFor: 1_000_000_000_000_000n,
    minUruFee: 1000n * E18,
    minUruFeeFor: 1000n * E18,
    curveSupply: 800_000_000n * E18,
    // sqrtPriceX96 for exactly 1,000,000 URU per ETH: sqrt(1e6) * 2^96
    sqrtPriceX96: 1000n * (1n << 96n),
    nameOk: [true, 0],
    tickerOk: [true, 0],
    ethBalance: 10n * E18,
    uruBalance: 1_000_000n * E18,
    uruAllowance: 0n,
    fairOpen: true,
    fairEthFee: 2_000_000_000_000_000n,
    fairMinUru: 500n * E18,
    fairUru: BOOK.URU,
    fairPredicted: ['0x5555555555555555555555555555555555555555', '0x6666666666666666666666666666666666666666', '0x7777777777777777777777777777777777777777'],
    codeAt: {},
    callReverts: null,
    rpcDown: false,
    curve: { price: 30_000_000_000n, graduated: false, ethReserve: E18, target: 4n * E18 },
    fairCurveFor: '0x0000000000000000000000000000000000000000',
    v10CurveFor: CURVE,
    batchFor: '0x0000000000000000000000000000000000000000',
    totalSupply: 1_000_000_000n * E18,
    receipts: {},
    calls: [],
  };
}

const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export function fakeClient(chain) {
  return {
    async getBlockNumber() {
      if (chain.rpcDown) throw new Error('rpc down');
      return chain.block;
    },
    async getBalance() {
      return chain.ethBalance;
    },
    async getCode({ address }) {
      return chain.codeAt[address.toLowerCase()] ?? '0x';
    },
    async call(args) {
      chain.calls.push(args);
      if (chain.callReverts) {
        const e = new Error(chain.callReverts);
        e.shortMessage = chain.callReverts;
        throw e;
      }
      return { data: '0x' };
    },
    async getTransactionReceipt({ hash }) {
      const r = chain.receipts[hash];
      if (!r) {
        const e = new Error('Transaction receipt not found');
        e.name = 'TransactionReceiptNotFoundError';
        throw e;
      }
      return r;
    },
    async getTransaction({ hash }) {
      return { hash, value: chain.receipts[hash]?.value ?? 0n };
    },
    async readContract({ address, functionName, args = [] }) {
      if (chain.rpcDown) throw new Error('rpc down');
      const fair = eq(address, BOOK.FairLaunchFactory);
      switch (functionName) {
        case 'paused': return chain.paused;
        case 'fees': return chain.erc20Fee;
        case 'moduleAddOnFee': return 0n;
        case 'minUruFee': return fair ? chain.fairMinUru : chain.minUruFee;
        case 'minUruFeeFor': return fair ? chain.fairMinUru : chain.minUruFeeFor;
        case 'quoteFor': return chain.quoteFor;
        case 'defaultCurveSupply': return chain.curveSupply;
        case 'defaultVirtualTokenReserve': return 1_073_000_000n * E18;
        case 'defaultVirtualEthReserve': return 17n * E18;
        case 'defaultGraduationTargetEth': return 10n * E18;
        case 'defaultTradeFeeBps': return 100;
        case 'validateName': return chain.nameOk;
        case 'validateTicker': return chain.tickerOk;
        case 'getSlot0': return [chain.sqrtPriceX96, 0, 0, 3000];
        case 'allowance': return chain.uruAllowance;
        case 'balanceOf': return chain.uruBalance;
        case 'totalSupply': return chain.totalSupply;
        case 'launchesOpen': return chain.fairOpen;
        case 'ethLaunchFee': return chain.fairEthFee;
        case 'ethFeeFor': return chain.fairEthFee;
        case 'uru': return chain.fairUru;
        case 'predictAddresses': return chain.fairPredicted;
        case 'curveFor':
          if (fair) return chain.fairCurveFor;
          return eq(args[0], TOKEN) ? chain.v10CurveFor : '0x0000000000000000000000000000000000000000';
        case 'batchFor': return chain.batchFor;
        case 'priceWeiPerToken': return chain.curve.price;
        case 'graduated': return chain.curve.graduated;
        case 'ethReserve': return chain.curve.ethReserve;
        case 'graduationTargetEth': return chain.curve.target;
        case 'token': return chain.tokenOf?.[address.toLowerCase()] ?? TOKEN;
        case 'closeTs': return 1_000n;
        case 'totalDeposited': return E18;
        case 'settled': return false;
        default: throw new Error(`fake chain: no ${functionName}`);
      }
    },
  };
}

export function fakeIndexer(over = {}) {
  return {
    async launchByToken(t) {
      return eq(t, TOKEN)
        ? { tokenAddress: TOKEN, launchedBy: LAUNCHER, name: 'Good Coin', ticker: 'GOOD', curveAddress: CURVE, payToken: 'ETH', feePaid: '1000', uruPaid: null, blockNumber: '1', blockTimestamp: '1700000000', txHash: '0x' + 'ab'.repeat(32) }
        : null;
    },
    async curveByToken(t) {
      return eq(t, TOKEN) ? { curveAddress: CURVE, ethReserve: String(E18), tokenReserve: '0', graduationTargetEth: String(4n * E18), tradeFeeBps: 100, tradeCount: 3, graduated: false } : null;
    },
    async graduationForToken() { return null; },
    async dn404ForBase() { return null; },
    async nftCollection() { return null; },
    async latestCurveTrades() {
      return [
        { trader: LAUNCHER, isBuy: true, ethAmount: '100', tokenAmount: '1000', priceWeiPerToken: '1', blockNumber: '5', blockTimestamp: '1700000005', txHash: '0x' + '01'.repeat(32) },
      ];
    },
    async v4SwapsForToken() {
      return [
        { poolId: '0x' + 'cd'.repeat(32), sender: BOOK.V4SwapRouter, amount0: '-200', amount1: '3000', priceWeiPerToken: '2', blockNumber: '9', blockTimestamp: '1700000009', txHash: '0x' + '02'.repeat(32) },
      ];
    },
    async v4SwapsForPoolId() { return []; },
    async holdersForToken() {
      return [
        { holderAddress: CURVE, balance: String(500_000_000n * E18) },
        { holderAddress: LAUNCHER, balance: String(10_000_000n * E18) },
      ];
    },
    ...over,
  };
}

export function fakeDeps({ chain = defaultChain(), indexer = {}, metadata = null, flags = {}, pin, fetchImage } = {}) {
  return {
    chain,
    deps: {
      client: fakeClient(chain),
      book: BOOK,
      flags: { launchpadLive: true, fairEnabled: true, nftEnabled: true, dn404Enabled: true, ...flags },
      indexer: fakeIndexer(indexer),
      metadata: async () => metadata,
      pinImage: pin ?? (async () => ({ cid: 'bafytest', gatewayUrl: 'https://gateway.example/ipfs/bafytest' })),
      fetchImage: fetchImage ?? (async () => { throw Object.assign(new Error('no network in tests'), { status: 502 }); }),
      checkDataUrl,
    },
  };
}
