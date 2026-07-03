#!/usr/bin/env bash
# Verify every Phase 1 contract on the target chain's block explorer. Reads addresses
# from `deployment.<chainid>.json` (written by DeployPhase1) so no manual copy-paste.
#
# Usage:
#   ./verify-phase1.sh sepolia
#   ./verify-phase1.sh mainnet
#
# Required env: ETHERSCAN_API_KEY (or BASESCAN_API_KEY for Base).
set -euo pipefail
cd "$(dirname "$0")"

CHAIN="${1:-sepolia}"

case "$CHAIN" in
  mainnet)      CHAIN_ID=1        ; API_KEY="${ETHERSCAN_API_KEY:-}" ; VERIFIER_URL="" ;;
  sepolia)      CHAIN_ID=11155111 ; API_KEY="${ETHERSCAN_API_KEY:-}" ; VERIFIER_URL="" ;;
  base)         CHAIN_ID=8453     ; API_KEY="${BASESCAN_API_KEY:-}"  ; VERIFIER_URL="https://api.basescan.org/api" ;;
  base-sepolia) CHAIN_ID=84532    ; API_KEY="${BASESCAN_API_KEY:-}"  ; VERIFIER_URL="https://api-sepolia.basescan.org/api" ;;
  *) echo "Unknown chain: $CHAIN"; exit 1 ;;
esac

if [[ -z "$API_KEY" ]]; then
  echo "Missing block-explorer API key for $CHAIN. Export ETHERSCAN_API_KEY (or BASESCAN_API_KEY for Base)."
  exit 1
fi

BOOK="deployment.${CHAIN_ID}.json"
if [[ ! -f "$BOOK" ]]; then
  echo "No address book at $BOOK. Broadcast DeployPhase1 first."
  exit 1
fi

echo ">>> Verifying Phase 1 on $CHAIN (chain id $CHAIN_ID)"

verify() {
  local name="$1"
  local contractPath="$2"
  local addrKey="$3"
  local args="${4:-}"

  local addr
  addr=$(node -e "console.log(require('./${BOOK}').${addrKey})")
  if [[ -z "$addr" || "$addr" == "undefined" ]]; then
    echo "  - $name: no address in book, skipping"
    return
  fi

  echo "  - $name @ $addr"
  # shellcheck disable=SC2086
  forge verify-contract "$addr" "$contractPath" \
    --chain-id "$CHAIN_ID" \
    --etherscan-api-key "$API_KEY" \
    ${VERIFIER_URL:+--verifier-url "$VERIFIER_URL"} \
    ${args:+--constructor-args $args} \
    --watch || echo "    ~ verification failed for $name (may already be verified)"
}

# Compute the exact constructor-args ABI blobs.
NAME_REGISTRY_ARGS=$(cast abi-encode "constructor(address,address,string[])" "$(cast --to-checksum $(node -e "console.log(require('./${BOOK}').NameRegistry)"))" "$(cast --to-checksum $(node -e "console.log(require('./${BOOK}').NameRegistry)"))" "[]")

verify "NameRegistry"  src/registry/NameRegistry.sol:NameRegistry NameRegistry
verify "FeeReceiver"   src/router/FeeReceiver.sol:FeeReceiver FeeReceiver
verify "Router"        src/router/Router.sol:Router Router
verify "ERC20Factory"  src/factories/ERC20Factory.sol:ERC20Factory ERC20Factory
verify "ERC721AFactory" src/factories/ERC721AFactory.sol:ERC721AFactory ERC721AFactory
verify "ERC1155Factory" src/factories/ERC1155Factory.sol:ERC1155Factory ERC1155Factory
verify "BondingCurve"  src/curve/BondingCurve.sol:BondingCurve BondingCurveImpl
verify "CurveFactory"  src/curve/CurveFactory.sol:CurveFactory CurveFactory

echo ">>> Verification pass complete. Constructor args for owned contracts must be"
echo ">>> supplied manually if verification fails — see contracts/verify-phase1.sh comments."
