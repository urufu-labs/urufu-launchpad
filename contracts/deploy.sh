#!/usr/bin/env bash
# Broadcast a Foundry script to any supported chain. Picks the right RPC + chain-id from
# the well-known chain slug. Requires DEV_PRIVATE_KEY + the chain's *_RPC_URL to be set.
#
# Usage:
#   ./deploy.sh <ScriptName> <chain>
#   CHAIN=mainnet ./deploy.sh Phase1
#
# Available scripts:
#   Phase1               → script/DeployPhase1.s.sol:DeployPhase1
#   Hooks                → script/DeployHooks.s.sol:DeployHooks
#   HandoffOwnership     → script/HandoffOwnership.s.sol:HandoffOwnership
#   PostDeploySmoke      → script/PostDeploySmoke.s.sol:PostDeploySmoke
set -euo pipefail
cd "$(dirname "$0")"

SCRIPT="${1:?script name required (Phase1 | Hooks | HandoffOwnership | PostDeploySmoke)}"
CHAIN="${2:-${CHAIN:-sepolia}}"

case "$CHAIN" in
  mainnet)      RPC="${MAINNET_RPC_URL:-}"      ; CHAIN_ID=1        ;;
  sepolia)      RPC="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}" ; CHAIN_ID=11155111 ;;
  base)         RPC="${BASE_RPC_URL:-}"         ; CHAIN_ID=8453     ;;
  base-sepolia) RPC="${BASE_SEPOLIA_RPC_URL:-}" ; CHAIN_ID=84532    ;;
  *)            echo "Unknown chain: $CHAIN"; exit 1 ;;
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
  Phase1)             TARGET="script/DeployPhase1.s.sol:DeployPhase1" ;;
  Hooks)              TARGET="script/DeployHooks.s.sol:DeployHooks" ;;
  HandoffOwnership)   TARGET="script/HandoffOwnership.s.sol:HandoffOwnership" ;;
  PostDeploySmoke)    TARGET="script/PostDeploySmoke.s.sol:PostDeploySmoke" ;;
  Flywheel)           TARGET="script/DeployFlywheel.s.sol:DeployFlywheel" ;;
  ConfigureFlywheel)  TARGET="script/ConfigureFlywheel.s.sol:ConfigureFlywheel" ;;
  *)                  echo "Unknown script: $SCRIPT"; exit 1 ;;
esac

echo ">>> Broadcasting $SCRIPT → $CHAIN (chain id $CHAIN_ID)"
echo ">>> RPC: $RPC"

forge script "$TARGET" \
  --rpc-url "$RPC" \
  --broadcast \
  --private-key "$DEV_PRIVATE_KEY" \
  -vvvv
