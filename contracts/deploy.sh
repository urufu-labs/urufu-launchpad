#!/usr/bin/env bash
# Broadcast a Foundry script to any supported chain. Picks the right RPC + chain-id from
# the well-known chain slug. Requires DEV_PRIVATE_KEY + the chain's *_RPC_URL to be set.
#
# Verification runs inline via --verify so contracts are verified on the block explorer
# during the same broadcast pass. Set SKIP_VERIFY=1 to skip and run verification later
# manually.
#
# Usage:
#   ./deploy.sh <ScriptName> <chain>
#   CHAIN=robinhood ./deploy.sh RouterV2
#   SKIP_VERIFY=1 ./deploy.sh RouterV2 robinhood
#
# Chain (Robinhood is canonical; others available for legacy work):
#   robinhood | robinhood-testnet | mainnet | sepolia | base | base-sepolia
#
# Available scripts (see case block below for the target mapping):
#   NameRegistry, V4SwapRouter, RouterV2, Flywheel, ConfigureFlywheel,
#   HandoffOwnership, SetChunkyDefaults, V6AuditFixStack, V9StackFix,
#   PublishFirstEpoch, VerifyWiring
#
# Post-broadcast: manually update .env with the new address(es), then bump
# the pinned constants in test/audit/RhLiveStackSnapshot.t.sol so the
# next `forge test` catches any wiring drift.
set -euo pipefail
cd "$(dirname "$0")"

SCRIPT="${1:?script name required — see header for available scripts}"
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
# NO_BROADCAST is flipped to 1 for scripts that emit an artifact for offline
# Safe submission instead of broadcasting on-chain (e.g. ActivateRouter). Those
# scripts intentionally require no DEV_PRIVATE_KEY and no --broadcast.
NO_BROADCAST=0

case "$SCRIPT" in
  NameRegistry)       TARGET="script/DeployNameRegistry.s.sol:DeployNameRegistry" ;;
  V4SwapRouter)       TARGET="script/DeployV4SwapRouter.s.sol:DeployV4SwapRouter" ;;
  Router|RouterV2)    TARGET="script/DeployRouter.s.sol:DeployRouter" ;;
  # URU-P1-B02: ActivateRouter's direct broadcast is disabled. Reroute the
  # command to the Safe-payload builder, which produces one MultiSendCallOnly
  # transaction for the multisig to sign — the only atomic cutover path.
  ActivateRouter)     TARGET="script/BuildRouterCutoverSafeBatch.s.sol:BuildRouterCutoverSafeBatch"; NO_BROADCAST=1 ;;
  Flywheel)           TARGET="script/DeployFlywheel.s.sol:DeployFlywheel" ;;
  ConfigureFlywheel)  TARGET="script/ConfigureFlywheel.s.sol:ConfigureFlywheel" ;;
  HandoffOwnership)   TARGET="script/HandoffOwnership.s.sol:HandoffOwnership" ;;
  SetChunkyDefaults)  TARGET="script/SetChunkyDefaults.s.sol:SetChunkyDefaults" ;;
  V6AuditFixStack)    TARGET="script/DeployV6AuditFixStack.s.sol:DeployV6AuditFixStack" ;;
  V9StackFix)         TARGET="script/DeployV9StackFix.s.sol:DeployV9StackFix" ;;
  PublishFirstEpoch)  TARGET="script/PublishFirstEpoch.s.sol:PublishFirstEpoch" ;;
  VerifyWiring)       TARGET="script/VerifyWiring.s.sol:VerifyWiring" ;;
  *)                  echo "Unknown script: $SCRIPT. Available: NameRegistry, V4SwapRouter, RouterV2, ActivateRouter, Flywheel, ConfigureFlywheel, HandoffOwnership, SetChunkyDefaults, V6AuditFixStack, V9StackFix, PublishFirstEpoch, VerifyWiring"; exit 1 ;;
esac

if [[ "$NO_BROADCAST" != "1" && -z "${DEV_PRIVATE_KEY:-}" ]]; then
  echo "DEV_PRIVATE_KEY not set. Cannot broadcast." >&2
  exit 1
fi

# Assemble inline verification args. Ownership-handoff and configure-only scripts don't
# deploy new contracts so verification is a no-op; every other script gets --verify.
VERIFY_ARGS=()
if [[ "${SKIP_VERIFY:-0}" == "1" ]]; then
  echo ">>> SKIP_VERIFY=1 → skipping inline verification. Run explorer verify manually later."
elif [[ "$NO_BROADCAST" == "1" || "$SCRIPT" == "HandoffOwnership" || "$SCRIPT" == "ConfigureFlywheel" || "$SCRIPT" == "SetChunkyDefaults" || "$SCRIPT" == "VerifyWiring" ]]; then
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

if [[ "$NO_BROADCAST" == "1" ]]; then
  echo ">>> Building atomic Safe payload for $SCRIPT → $CHAIN (chain id $CHAIN_ID)"
  echo ">>> RPC: $RPC"
  forge script "$TARGET" \
    --rpc-url "$RPC" \
    --chain-id "$CHAIN_ID" \
    -vvvv
  echo ">>> Payload written locally. Submit it as ONE Safe transaction; nothing was broadcast."
  exit 0
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
