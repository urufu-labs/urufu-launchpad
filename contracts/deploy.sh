#!/usr/bin/env bash
# Broadcast a Foundry script to any supported chain. Picks the right RPC + chain-id from
# the well-known chain slug. Requires DEV_PRIVATE_KEY + the chain's *_RPC_URL to be set.
#
# Verification runs inline via --verify so contracts are verified on the block explorer
# during the same broadcast pass. If a contract fails to verify (typical for CREATE2-mined
# hook addresses where forge can't match the source), re-run verify-phase1.sh.
#
# Usage:
#   ./deploy.sh <ScriptName> <chain>
#   CHAIN=mainnet ./deploy.sh Phase1
#   SKIP_VERIFY=1 ./deploy.sh Phase1 sepolia    # opt out of inline verification
#
# Chains:
#   mainnet | sepolia | base | base-sepolia | robinhood | robinhood-testnet
#
# Scripts:
#   NameRegistry         → script/DeployNameRegistry.s.sol:DeployNameRegistry
#   Phase1               → script/DeployPhase1.s.sol:DeployPhase1
#   Hooks                → script/DeployHooks.s.sol:DeployHooks
#   Graduator            → script/DeployGraduator.s.sol:DeployGraduator
#   MigrateToV2Hook      → script/MigrateToV2Hook.s.sol:MigrateToV2Hook
#                          (new MultiHookHost with per-pool creator + new Graduator wired to it)
#   V4SwapRouter         → script/DeployV4SwapRouter.s.sol:DeployV4SwapRouter
#   Flywheel             → script/DeployFlywheel.s.sol:DeployFlywheel
#   ConfigureFlywheel    → script/ConfigureFlywheel.s.sol:ConfigureFlywheel
#   HandoffOwnership     → script/HandoffOwnership.s.sol:HandoffOwnership
#   PostDeploySmoke      → script/PostDeploySmoke.s.sol:PostDeploySmoke
#
# Recommended deploy order for a fresh chain:
#   Phase1 → Hooks → Graduator (WIRE_INTO_FACTORY=1) → V4SwapRouter → Flywheel
#   → ConfigureFlywheel → node tools/sync-addresses.mjs <chain> → HandoffOwnership
set -euo pipefail
cd "$(dirname "$0")"

SCRIPT="${1:?script name required (NameRegistry | Phase1 | Hooks | Graduator | MigrateToV2Hook | Flywheel | ConfigureFlywheel | HandoffOwnership | PostDeploySmoke)}"
CHAIN="${2:-${CHAIN:-sepolia}}"

# Chain → RPC, chain-id, and verifier settings for inline `--verify`.
# EXPLORER_KIND is one of: etherscan | blockscout | none
case "$CHAIN" in
  mainnet)
    RPC="${MAINNET_RPC_URL:-}"                            ; CHAIN_ID=1
    EXPLORER_KIND=etherscan ; EXPLORER_KEY="${ETHERSCAN_API_KEY:-}"  ; EXPLORER_URL=""
    ;;
  sepolia)
    RPC="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}" ; CHAIN_ID=11155111
    EXPLORER_KIND=etherscan ; EXPLORER_KEY="${ETHERSCAN_API_KEY:-}"  ; EXPLORER_URL=""
    ;;
  base)
    RPC="${BASE_RPC_URL:-}"                               ; CHAIN_ID=8453
    EXPLORER_KIND=etherscan ; EXPLORER_KEY="${BASESCAN_API_KEY:-}"   ; EXPLORER_URL=""
    ;;
  base-sepolia)
    RPC="${BASE_SEPOLIA_RPC_URL:-}"                       ; CHAIN_ID=84532
    EXPLORER_KIND=etherscan ; EXPLORER_KEY="${BASESCAN_API_KEY:-}"   ; EXPLORER_URL=""
    ;;
  robinhood)
    RPC="${ROBINHOOD_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}" ; CHAIN_ID=4663
    EXPLORER_KIND=blockscout ; EXPLORER_KEY="${BLOCKSCOUT_API_KEY:-none}" ; EXPLORER_URL="https://robinhoodchain.blockscout.com/api"
    ;;
  robinhood-testnet)
    RPC="${ROBINHOOD_TESTNET_RPC_URL:-https://rpc.testnet.chain.robinhood.com}" ; CHAIN_ID=46630
    EXPLORER_KIND=blockscout ; EXPLORER_KEY="${BLOCKSCOUT_API_KEY:-none}" ; EXPLORER_URL="https://robinhoodchain-testnet.blockscout.com/api"
    ;;
  *)
    echo "Unknown chain: $CHAIN"; exit 1
    ;;
esac

if [[ -z "${RPC:-}" ]]; then
  echo "No RPC URL for $CHAIN. Set the matching *_RPC_URL env var." >&2
  exit 1
fi
if [[ -z "${DEV_PRIVATE_KEY:-}" ]]; then
  echo "DEV_PRIVATE_KEY not set. Cannot broadcast." >&2
  exit 1
fi

case "$SCRIPT" in
  NameRegistry)       TARGET="script/DeployNameRegistry.s.sol:DeployNameRegistry" ;;
  Phase1)             TARGET="script/DeployPhase1.s.sol:DeployPhase1" ;;
  Hooks)              TARGET="script/DeployHooks.s.sol:DeployHooks" ;;
  Graduator)          TARGET="script/DeployGraduator.s.sol:DeployGraduator" ;;
  MigrateToV2Hook)    TARGET="script/MigrateToV2Hook.s.sol:MigrateToV2Hook" ;;
  MigrateToV2Templates) TARGET="script/MigrateToV2Templates.s.sol:MigrateToV2Templates" ;;
  V4SwapRouter)       TARGET="script/DeployV4SwapRouter.s.sol:DeployV4SwapRouter" ;;
  HandoffOwnership)   TARGET="script/HandoffOwnership.s.sol:HandoffOwnership" ;;
  PostDeploySmoke)    TARGET="script/PostDeploySmoke.s.sol:PostDeploySmoke" ;;
  Flywheel)           TARGET="script/DeployFlywheel.s.sol:DeployFlywheel" ;;
  ConfigureFlywheel)  TARGET="script/ConfigureFlywheel.s.sol:ConfigureFlywheel" ;;
  *)                  echo "Unknown script: $SCRIPT"; exit 1 ;;
esac

# Assemble inline verification args. Ownership-handoff and configure-only scripts don't
# deploy new contracts so verification is a no-op; every other script gets --verify.
VERIFY_ARGS=()
if [[ "${SKIP_VERIFY:-0}" == "1" ]]; then
  echo ">>> SKIP_VERIFY=1 → skipping inline verification. Run verify-phase1.sh $CHAIN later."
elif [[ "$SCRIPT" == "HandoffOwnership" || "$SCRIPT" == "ConfigureFlywheel" || "$SCRIPT" == "PostDeploySmoke" ]]; then
  : # no new contracts to verify
elif [[ "$EXPLORER_KIND" == "etherscan" ]]; then
  if [[ -z "$EXPLORER_KEY" ]]; then
    echo "Missing explorer API key for $CHAIN (ETHERSCAN_API_KEY or BASESCAN_API_KEY)." >&2
    echo "Export it, or re-run with SKIP_VERIFY=1 to skip inline verification." >&2
    exit 1
  fi
  VERIFY_ARGS=(--verify --etherscan-api-key "$EXPLORER_KEY")
elif [[ "$EXPLORER_KIND" == "blockscout" ]]; then
  VERIFY_ARGS=(--verify --verifier blockscout --verifier-url "$EXPLORER_URL")
fi

echo ">>> Broadcasting $SCRIPT → $CHAIN (chain id $CHAIN_ID)"
echo ">>> RPC: $RPC"
if [[ ${#VERIFY_ARGS[@]} -gt 0 ]]; then
  echo ">>> Inline verify: enabled ($EXPLORER_KIND)"
else
  echo ">>> Inline verify: skipped"
fi

# --slow makes forge send one tx at a time and wait for each receipt before the next.
# Required on Base Sepolia when the deploy key is EIP-7702-delegated (node caps in-flight
# tx count for 7702 accounts); harmless-but-slower elsewhere. Opt out with FAST=1 if you
# know the key isn't 7702-delegated and want the parallel broadcast.
SLOW_ARGS=()
if [[ "${FAST:-0}" != "1" ]]; then
  SLOW_ARGS=(--slow)
fi

forge script "$TARGET" \
  --rpc-url "$RPC" \
  --chain-id "$CHAIN_ID" \
  --broadcast \
  --private-key "$DEV_PRIVATE_KEY" \
  "${SLOW_ARGS[@]}" \
  "${VERIFY_ARGS[@]}" \
  -vvvv
