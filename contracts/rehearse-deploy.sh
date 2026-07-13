#!/usr/bin/env bash
# Rehearse a deploy locally against a forked chain (no broadcast).
# Runs the deploy script in-memory against real forked state so you can verify
# gas estimates, revert paths, and post-deploy console output before touching
# a real key on a real chain.
#
# Usage:
#   ./rehearse-deploy.sh <script-name>      # uses $SEPOLIA_RPC_URL by default
#   ./rehearse-deploy.sh <script-name> mainnet
#
# Example:
#   ./rehearse-deploy.sh DeployNameRegistry
#   ./rehearse-deploy.sh DeployNameRegistry mainnet

set -euo pipefail
cd "$(dirname "$0")"

SCRIPT="${1:-DeployNameRegistry}"
NETWORK="${2:-sepolia}"

case "$NETWORK" in
  sepolia)            RPC="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}" ;;
  mainnet)            RPC="${MAINNET_RPC_URL:-}" ;;
  base)               RPC="${BASE_RPC_URL:-}" ;;
  base-sepolia)       RPC="${BASE_SEPOLIA_RPC_URL:-}" ;;
  robinhood)          RPC="${ROBINHOOD_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}" ;;
  robinhood-testnet)  RPC="${ROBINHOOD_TESTNET_RPC_URL:-https://rpc.testnet.chain.robinhood.com}" ;;
  *)                  echo "Unknown network: $NETWORK"; exit 1 ;;
esac

if [[ -z "$RPC" ]]; then
  echo "No RPC URL set for $NETWORK. Export the matching *_RPC_URL env var."
  exit 1
fi

echo ">>> Rehearsing $SCRIPT against fork of $NETWORK ($RPC)"
echo ">>> This runs in-memory; nothing is broadcast."
echo ""

forge script "script/${SCRIPT}.s.sol:${SCRIPT}" \
  --fork-url "$RPC" \
  --sender 0x1000000000000000000000000000000000000001 \
  -vvvv
