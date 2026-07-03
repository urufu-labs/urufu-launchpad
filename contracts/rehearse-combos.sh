#!/usr/bin/env bash
# Rehearse EVERY curated impl combo against a forked chain (no broadcast).
# Runs `PhaseCombosTest` — deploys the full Phase 1 stack + launches every impl through
# the Router — but with real forked chain state, so gas prices, block times, and any
# chain-specific weirdness get exercised end-to-end before touching a live key.
#
# Usage:
#   ./rehearse-combos.sh              # sepolia by default
#   ./rehearse-combos.sh mainnet
#   ./rehearse-combos.sh base-sepolia
#
# Prints a per-combo pass/fail line; nonzero exit if any combo fails.
set -euo pipefail
cd "$(dirname "$0")"

NETWORK="${1:-sepolia}"

case "$NETWORK" in
  sepolia)      RPC="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}" ;;
  mainnet)      RPC="${MAINNET_RPC_URL:-}" ;;
  base)         RPC="${BASE_RPC_URL:-}" ;;
  base-sepolia) RPC="${BASE_SEPOLIA_RPC_URL:-}" ;;
  *)            echo "Unknown network: $NETWORK"; exit 1 ;;
esac

if [[ -z "$RPC" ]]; then
  echo "No RPC URL set for $NETWORK. Export the matching *_RPC_URL env var."
  exit 1
fi

echo ">>> Rehearsing every registered combo against fork of $NETWORK"
echo ">>> RPC: $RPC"
echo ">>> This runs in-memory; nothing is broadcast."
echo ""

forge test \
  --match-contract PhaseCombosTest \
  --fork-url "$RPC" \
  -vv
