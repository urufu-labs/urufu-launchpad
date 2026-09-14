# DN404 Dark-Deploy Runbook

> One-shot: stand up the whole DN404 lane on RH mainnet, off-flip, verified.
>
> **Status:** ready to broadcast. Contracts + deploy script + verify script
> + keeper worker are all merged on `dn404-lane`. Site stays dark until the
> post-deploy checks pass and the flip commit lands.

## Preconditions

1. `dn404-lane` branch checked out, `git status` clean.
2. `forge build` and `forge test --match-path "test/dn404/**"` both green
   locally. (The two live-fork tests run against the RH mainnet fork —
   if `ROBINHOOD_RPC_URL` is unset they skip cleanly; that's expected
   for pre-flight, but you'll want to run them at least once with the
   env set to verify against real state.)
3. `contracts/deployment-live-rh.4663.json`, `deployment-flywheel.4663.json`,
   `deployment.4663.json`, and `deployment-nft.4663.json` all present.
   The script reads V10 CurveFactory / PoolManager / FeeSplitter /
   LoyaltyOracle / UruDepositSink / NftLaunchFactory addresses out of
   these books — none of them are re-typed in env.
4. Deployer wallet holds enough ETH on RH for ~10 contract deploys +
   ~12 setter calls. Estimate: ~0.05 ETH covers a comfortable buffer.
5. **You** have the V10 CurveFactory owner's authority. If you don't,
   step (l) of the deploy script silently skips and you must run
   `CurveFactory.setTrustedRouter(Dn404LaunchFactory, true)` separately
   before the ETH-pair path works.

## Env template

Create `contracts/.env.dn404` from this template. Values below match
RH mainnet defaults; adjust the two keeper wallets to your own before
broadcasting.

```bash
# --- broadcast identity ---
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com
DEV_PRIVATE_KEY=0x…                     # broadcaster; owns the freshly-deployed contracts

# --- admin / owner of every new DN404 contract ---
# Defaults to msg.sender (i.e. broadcaster). Only override if you want
# governance to live on a multisig from day one.
# ADMIN=0x…

# --- required for the deploy ---
URU_TOKEN_ADDRESS=0x9fbe210007dDd8389f98d0253018e65CC48b9D24

# The keeper role: a hot wallet run by the launchpad ops team that
# calls sweepAccumulated on every tax-enabled DN404 launch. NOT the
# launcher's wallet, NOT the multisig — dedicated address.
DN404_TAX_KEEPER=0x…                    # dedicated keeper wallet
DN404_TAX_TREASURY=0x…                  # 5% keeper fee lands here

# --- optional overrides ---
# DN404_MHH_PLATFORM_BPS=100             # default 100 (= 1%)
# DN404_MHH_CREATOR_BPS=100              # default 100 (= 1%)
# DN404_GRAD_FEE=3000                    # default 3000 (= 30 bps)
# DN404_GRAD_TICKSPACING=60              # default 60
```

## Broadcast

From `contracts/` with the env loaded:

```bash
source .env.dn404
forge script script/DeployDn404Lane.s.sol \
  --rpc-url $ROBINHOOD_RPC_URL \
  --private-key $DEV_PRIVATE_KEY \
  --broadcast
```

The script:

1. Deploys 10 contracts (2 registries + 3 impls + curve impl + curve
   factory + mined MHH + graduator + launch factory).
2. Wires all of them together in the same broadcast.
3. Best-effort trusts the fresh Dn404LaunchFactory on the V10
   CurveFactory (only if the broadcaster owns V10 CF).
4. Runs `_assertInvariants` — reverts loudly if any wire is off.
5. Writes `contracts/deployment-dn404.4663.json` on success.

Expect it to take ~2–3 minutes. Salt mining is the slow step.

## Post-deploy verification

Run the read-only verify script against the freshly-written address
book. Reverts loudly on any drift.

```bash
forge script script/VerifyDn404Deploy.s.sol \
  --rpc-url $ROBINHOOD_RPC_URL
```

Then verify manually on Blockscout:

```bash
# One-liners per contract. Fill in addresses from deployment-dn404.4663.json.
cast code --rpc-url $ROBINHOOD_RPC_URL <addr>   # non-empty means deployed
cast call --rpc-url $ROBINHOOD_RPC_URL <Dn404LaunchFactory> "owner()(address)"
cast call --rpc-url $ROBINHOOD_RPC_URL <Dn404LaunchFactory> "baseImpl()(address)"
```

Then queue Blockscout source verification. Same pattern the V10 stack
uses (per `feedback_always_verify_contracts.md`): Blockscout `--verifier-url`
+ `BLOCKSCOUT_API_KEY=unused`, `runs=10000`, `via_ir=true`.

## Uniswap hook allowlist (manual, off-chain)

The mined MHH address is a new v4 hook. Uniswap's hook allowlist is
an off-chain review — submit at https://github.com/Uniswap/v4-hooks
or ping their team directly. Provide:

- Mined MHH address (from `deployment-dn404.4663.json.Dn404MultiHookHost`)
- Source repo link (this branch) so they can review the code
- Confirmation this MHH is byte-identical to the V10 one already
  allowlisted (only the deployment salt differs)

Existing DN404 curves can trade before allowlisting; graduation is
what needs it — the v4 pool created at graduation goes through the
allowlisted-hook check.

## Rollback

**Blast radius: zero.** The DN404 lane runs on completely separate
contracts. Rolling back means one of:

1. **Nothing shipped yet, only deployed.** Leave the contracts as-is.
   Their orphan state is inert. Redeploy fresh contracts when ready.
2. **Contracts deployed, keeper started, no launches yet.** Stop the
   keeper (SIGTERM). Site flip is still off. Redeploy at will.
3. **Launches happened.** Existing launches keep working — their
   curves + graduators are self-contained. To stop NEW launches:
   flip `DN404_LAUNCHES_ENABLED.robinhood = false` in
   `web/src/lib/launchpadStatus.ts` and redeploy the web app.

No V10 stack contract is touched by any of these paths. The one wire
that crosses into V10 territory — `V10 CF.setTrustedRouter(Dn404LF)` —
can be reversed with `V10 CF.setTrustedRouter(Dn404LF, false)` from
the V10 CF owner. Zero effect on existing ERC-20 launches.

## What to update after post-deploy pass

Once the verify script is green:

1. Update `MEMORY.md` with a `project_dn404_v1_deploy.md` entry
   naming every deployed address, deploy block, and the deploy
   session. Same shape as `project_robinhood_v10_deploy.md`.
2. Configure the keeper worker (`keeper/.env`):
   - `KEEPER_PRIVATE_KEY` = same wallet as `DN404_TAX_KEEPER` above
   - `KEEPER_V4_SWAP_ROUTER` = value already in `deployment-live-rh.4663.json.v4SwapRouter`
   - `KEEPER_URU_TOKEN` = URU_TOKEN_ADDRESS above
   - `KEEPER_URU_BUYBACK_SINK` = URU buyback vault or dead-address (ops call)
   - `KEEPER_ADVANCED_DEST_TREASURY` = shared treasury for the three stub destinations
   - `KEEPER_LAUNCHES=[]` — empty until first tax-enabled launch, then populate per launch
3. Deploy the keeper to Railway / Fly / bare host with the env above.
   Watch its logs — one line per launch per tick.
4. Update `web/src/lib/config.ts` with the fresh DN404 addresses so
   `/create/dn404` and `/trade/[addr]` point at the live stack.
5. Restart the indexer with the fresh `Dn404LaunchFactory` address
   env var — indexer's block scan begins at deploy block.
6. Internal smoke: launch a test DN404, buy through curve, graduate,
   verify indexer picks it up + `/trade/[addr]` renders correctly.
7. 48h watch window. If clean, ship the flip commit.

## The flip commit

Two flags in one commit, one PR:

```ts
// web/src/lib/launchpadStatus.ts
export const NFT_LAUNCHES_ENABLED = { robinhood: true, /* ... */ };
export const DN404_LAUNCHES_ENABLED = { robinhood: true, /* ... */ };
```

Merge → deploy web → done. Also drop `indexer/ponder.config.ts`
`pollingInterval` from 30s to 5s so trades feel live (per
`project_indexer_polling_prelaunch.md`).
