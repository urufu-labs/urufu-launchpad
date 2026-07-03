# Existing ecosystem contracts

The urufu labs flywheel routes value into these two contracts that Brandon deployed for
the `urufu gemu` game. The launchpad's `LoyaltyOracle`, `NftRevenueVault`, and
`UruBuybackVault` all read/write against them.

**Chain:** Base mainnet (assumed — verify per broadcast).

| Contract | Address | Purpose |
|---|---|---|
| **URU token** (ERC-20) | `0xF018A077a59fD9a24e99B76D0a7d0780792eB1Ac` | Governance + flywheel target. Buyback vault swaps ETH → URU here. Discount on launch fees via LoyaltyOracle for holders above threshold. |
| **urufu gemu NFT** | `0xE9FfA2B7Dc3b7012A4E919DA293E663ddfbFec9A` | Revenue-share holders. NftRevenueVault distributes ETH pro-rata via merkle drops. LoyaltyOracle checks `balanceOf` for launch-fee discount. |

## How these get consumed

- `.env` on the Base broadcast run should set:
  ```
  URU_TOKEN_ADDRESS=0xF018A077a59fD9a24e99B76D0a7d0780792eB1Ac
  GEMU_NFT_ADDRESS=0xE9FfA2B7Dc3b7012A4E919DA293E663ddfbFec9A
  ```
- `DeployFlywheel.s.sol` reads them, deploys LoyaltyOracle + vaults pointed at them, and
  emits addresses into `deployment-flywheel.<chainid>.json` for the web/indexer to sync.
- Other chains (Sepolia, mainnet, Base Sepolia) either don't get the flywheel deployed at
  all OR use zero-address stubs so the launchpad still works without them.
