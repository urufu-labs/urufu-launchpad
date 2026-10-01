# Uniswap v4 Hook Allowlist Submission — Dn404MultiHookHost

**Copy this into a PR at https://github.com/Uniswap/v4-hooks (or DM the
Uniswap team the same info). Submission is a review, not automated.**

---

## Hook Address

`0x6d8701058E4eecA3bF80D14bD6C13A89575460C4`

**Chain:** Robinhood Mainnet (chainid 4663)
**Deployed:** 2026-09-15

## Relationship to already-allowlisted MHH

This is a byte-identical instance of `MultiHookHost.sol` (contracts/src/hooks/MultiHookHost.sol), which is **already allowlisted for the same chain** at `0x48C22af8Ad989fc9d5e82D6055dc0F263076e0C4` (the V10 ERC-20 lane host, allowlisted 2026-08-12 following the V10 stack rotation).

The **only** differences between the two deployments:

1. **CREATE2 salt.** Fresh salt mined for the DN404 lane so the address bits satisfy v4's permission-mask requirement independently.
2. **`_deployer` constructor arg.** Points at the DN404 admin wallet, not the ERC-20 admin, so `setInitializer` is bound to a different one-shot caller.
3. **`initializer` state slot.** Set to the DN404 Graduator (`0xE23E49EeD1a8BEc5c08E6C94e7808Dc96aa02944`) in the same broadcast that deployed this host. The V10 host is bound to the V10 Graduator.

Source code, constructor immutables (`platform`, `creator`, `platformBps`, `creatorBps`) — **identical** to the currently-allowlisted host. No new attack surface.

## Live pool for routing tests (the form requires one)

The Hooks Routing Allowlist form is required because this host uses
`afterSwapReturnsDelta`, and it asks for a live pool created with the hook.
One exists on Robinhood mainnet as of 2026-09-23:

| Field | Value |
|---|---|
| Pool id | `0xe866d28f412e92d9310fce42f927fa5fc85d16777511ac8f52068ce62bb080c7` |
| currency0 | `0x46377623F4Dd0470f5eA6F6120146F0801a26514` (REH404, a DN404 base token) |
| currency1 | `0x9fbe210007dDd8389f98d0253018e65CC48b9D24` (URU, 18 decimals) |
| fee / tickSpacing | 3000 / 60 |
| hooks | `0x6d8701058E4eecA3bF80D14bD6C13A89575460C4` |
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| Initialized in tx | `0x9a4163fcb5d439b54984df433575e546652060137c6a3b17350e2a8b7cee5fdb` (block 70645991) |
| Opening sqrtPriceX96 | `278713285600353317531635121` |
| Liquidity | `14142135623771150976036` (full range, held by the Graduator) |

The pool was seeded by `contracts/script/RehearseDn404UruPair.s.sol`
(fork-tested first by `contracts/test/dn404/RehearseDn404UruPairFork.t.sol`,
which also asserts the pool opened at the curve's marginal price, 0 bps off).
Both tokens are ERC-20; the hook takes its fee as a returned delta in
`afterSwap`, exactly as the already-allowlisted ERC-20 lane host does.

### Form answers

- Does the hook use `beforeSwapReturnsDelta`: **no**
- Does the hook use `afterSwapReturnsDelta`: **yes** (platform + creator fee, 100 bps each, plus optional buyback burn)
- Does the hook use `dynamicFees`: **no**
- Pool to test against: the table above

## Permission Mask

Encoded in the low 14 bits of the hook address (`0x3FFF` mask):

```
BEFORE_INITIALIZE_FLAG        (1 << 13)
BEFORE_SWAP_FLAG              (1 << 7)
AFTER_SWAP_FLAG               (1 << 6)
AFTER_SWAP_RETURNS_DELTA_FLAG (1 << 2)

Combined mask:  0x20C4
Address & 0x3FFF: 0x20C4 ✅
```

Same permission set as the already-allowlisted V10 host.

## Why a second deployment

The Uniswap MHH V10 host is locked (via `setInitializer` one-shot) to the V10 curve-stack Graduator. A DN404 pair graduates through the parallel DN404 curve stack + DN404 Graduator, so it needs its own host instance to accept those `beforeInitialize` calls.

Both hosts serve the same launchpad, live on the same chain, and route fees through the same fee-splitter contract. No duplication of hook logic — just a second binding for a second graduator.

## Source Verification

- Repo: <fill in the launchpad repo URL when submitting>
- Contract: `contracts/src/hooks/MultiHookHost.sol` (byte-identical to V10)
- Deploy script: `contracts/script/DeployDn404Lane.s.sol::_mineAndDeployMhh`
- Verify script: `contracts/script/VerifyDn404Deploy.s.sol` (checks the mask + initializer lock)
- On-chain verifier: Blockscout (run `contracts:security` deploy step after acceptance)

## Prior Security Work

- Slither: 0 High findings on the DN404 lane after triage
- Internal /security-review: 1 HIGH found and fixed (keeper role split from
  launcher owner — commit `8b7867e` on the `dn404-lane` branch)
- 54 fork tests pass against live RH mainnet state, including the full
  launch → buy → graduate flow which exercises this host's
  `beforeInitialize` gate + `afterSwap` fee routing end-to-end
- No external audit yet (v1 launch decision to broadcast pre-audit)

## Contact

x.com/spoobsV1
