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
