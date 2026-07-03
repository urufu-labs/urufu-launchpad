import { createConfig } from '@ponder/core';
import { http, parseAbi, parseAbiItem } from 'viem';

// Contract addresses — populate after DeployPhase1 broadcasts to Sepolia. Until then Ponder
// starts up but only produces empty indexes. All are `undefined`-safe: the createConfig call
// stays valid, but `contracts` with an undefined address skip indexing until an address is set.

const SEPOLIA = 11_155_111;
const START_BLOCK_SEPOLIA = Number(process.env.PONDER_START_BLOCK_SEPOLIA ?? 6_000_000);

const CONTRACTS = {
  NameRegistry: process.env.NEXT_PUBLIC_NAME_REGISTRY_ADDRESS as `0x${string}` | undefined,
  Router: process.env.NEXT_PUBLIC_ROUTER_ADDRESS as `0x${string}` | undefined,
  ERC20Factory: process.env.NEXT_PUBLIC_ERC20_FACTORY_ADDRESS as `0x${string}` | undefined,
  ERC721AFactory: process.env.NEXT_PUBLIC_ERC721A_FACTORY_ADDRESS as `0x${string}` | undefined,
  ERC1155Factory: process.env.NEXT_PUBLIC_ERC1155_FACTORY_ADDRESS as `0x${string}` | undefined,
  CurveFactory: process.env.NEXT_PUBLIC_CURVE_FACTORY_ADDRESS as `0x${string}` | undefined,
} as const;

// ABIs — human-readable via parseAbi, same shape wagmi uses on the client side.
export const nameRegistryAbi = parseAbi([
  'event Reserved(bytes32 indexed nameHash, bytes32 indexed tickerHash, address indexed token, address launchedBy, string name, string ticker, uint256 timestamp, uint256 chainId)',
]);

export const routerAbi = parseAbi([
  'event Launched(address indexed token, address indexed launchedBy, uint8 indexed base, bytes32 nameHash, bytes32 tickerHash, uint256 feePaid, bool installedHook, bool installedGovernance)',
  'event CurveInstalled(address indexed token, address indexed curve)',
]);

export const factoryAbi = parseAbi([
  'event Deployed(address indexed token, address indexed launcher, bytes32 indexed configHash, address impl, string name, string ticker)',
]);

export const curveFactoryAbi = parseAbi([
  'event CurveCreated(address indexed token, address indexed curve, address indexed launcher)',
]);

export const bondingCurveAbi = parseAbi([
  'event CurveInitialized(address indexed token, address indexed feeReceiver, uint256 curveSupply, uint256 virtualTokenReserve, uint256 virtualEthReserve, uint256 graduationTargetEth, uint16 tradeFeeBps)',
  'event Trade(address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 ethReserve, uint256 tokenReserve, uint256 timestamp)',
  'event Graduated(uint256 ethReserve, uint256 tokenReserve, uint256 timestamp)',
]);

export const erc20Abi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export default createConfig({
  networks: {
    sepolia: {
      chainId: SEPOLIA,
      transport: http(process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'),
    },
  },
  contracts: {
    NameRegistry: {
      network: 'sepolia',
      abi: nameRegistryAbi,
      address: CONTRACTS.NameRegistry,
      startBlock: START_BLOCK_SEPOLIA,
    },
    Router: {
      network: 'sepolia',
      abi: routerAbi,
      address: CONTRACTS.Router,
      startBlock: START_BLOCK_SEPOLIA,
    },
    ERC20Factory: {
      network: 'sepolia',
      abi: factoryAbi,
      address: CONTRACTS.ERC20Factory,
      startBlock: START_BLOCK_SEPOLIA,
    },
    ERC721AFactory: {
      network: 'sepolia',
      abi: factoryAbi,
      address: CONTRACTS.ERC721AFactory,
      startBlock: START_BLOCK_SEPOLIA,
    },
    ERC1155Factory: {
      network: 'sepolia',
      abi: factoryAbi,
      address: CONTRACTS.ERC1155Factory,
      startBlock: START_BLOCK_SEPOLIA,
    },
    CurveFactory: {
      network: 'sepolia',
      abi: curveFactoryAbi,
      address: CONTRACTS.CurveFactory,
      startBlock: START_BLOCK_SEPOLIA,
    },
    // Every BondingCurve is a clone deployed by CurveFactory. Ponder's inline `factory` config
    // subscribes to CurveCreated events and adds each new curve address as a Trade+Graduated
    // source dynamically. No per-launch config change needed.
    BondingCurve: {
      network: 'sepolia',
      abi: bondingCurveAbi,
      ...(CONTRACTS.CurveFactory
        ? {
            factory: {
              address: CONTRACTS.CurveFactory,
              event: parseAbiItem(
                'event CurveCreated(address indexed token, address indexed curve, address indexed launcher)',
              ),
              parameter: 'curve' as const,
            },
          }
        : {}),
      startBlock: START_BLOCK_SEPOLIA,
    },
  },
});
