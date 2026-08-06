# Existing ecosystem contracts

> **Status:** current
> _last updated: 2026-08-05_

The urufu labs flywheel routes value into these two contracts that Brandon deployed for
the `urufu gemu` game. The launchpad's `LoyaltyOracle`, `NftRevenueVault`, and
`UruBuybackVault` all read/write against them.

**Post-migration (2026-07):** URU + urufu gemu NFT are now on **Robinhood chain** (id 4663).
The Base deployments still exist but are legacy — new launches / flywheel deploys should
target Robinhood.

## Canonical (Robinhood chain, id 4663)

| Contract | Address | Purpose |
|---|---|---|
| **URU token** (ERC-20) | `0x9fbe210007dDd8389f98d0253018e65CC48b9D24` | Governance + flywheel target. Buyback vault swaps ETH → URU here. Discount on launch fees via LoyaltyOracle for holders above threshold. |
| **urufu gemu NFT** (ChibiCoreV2) | `0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17` | Revenue-share holders. NftRevenueVault distributes ETH pro-rata via merkle drops. LoyaltyOracle checks `balanceOf` for launch-fee discount. |

Additional Robinhood ecosystem addresses (Minter, Vault, GameController, YieldReserve,
ClashEscrow, UruLaunchHook, URU/WETH pool ID, PoolManager, PositionManager, UniversalRouter,
StateView, Quoter, Permit2) — see `memory/project_robinhood_addresses.md`.

## Legacy (Base mainnet, id 8453)

Kept here for reference — do NOT use for new deploys.

| Contract | Legacy Base address | Notes |
|---|---|---|
| URU token | `0xF018A077a59fD9a24e99B76D0a7d0780792eB1Ac` | Pre-migration deployment. |
| urufu gemu NFT | `0xE9FfA2B7Dc3b7012A4E919DA293E663ddfbFec9A` | Pre-migration deployment. |

## How these get consumed

- `.env` on the Robinhood broadcast run should set:
  ```
  URU_TOKEN_ADDRESS=0x9fbe210007dDd8389f98d0253018e65CC48b9D24
  GEMU_NFT_ADDRESS=0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17
  ```
- `DeployFlywheel.s.sol` reads them, deploys LoyaltyOracle + vaults pointed at them, and
  emits addresses into `deployment-flywheel.<chainid>.json` for the web/indexer to sync.
- Other chains (Sepolia, mainnet, Base, Base Sepolia) either don't get the flywheel
  deployed at all OR use zero-address stubs so the launchpad still works without them.
  The launchpad is currently RH-only in the UI (see `memory/project_launchpad_rh_only.md`).
