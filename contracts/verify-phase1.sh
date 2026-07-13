#!/usr/bin/env bash
# Verify every deployed contract on the target chain's block explorer. Reads addresses
# from the appropriate `deployment*.<chainid>.json` book so no manual copy-paste.
#
# Usage:
#   ./verify-phase1.sh <chain> [subsystem]
#     chain     : sepolia | mainnet | base | base-sepolia | robinhood | robinhood-testnet
#     subsystem : phase1 (default) | hooks | graduator | flywheel
#
# Required env: ETHERSCAN_API_KEY (mainnet/sepolia) or BASESCAN_API_KEY (base/base-sepolia)
#               or BLOCKSCOUT_API_KEY (robinhood — optional, public endpoint accepts any key).
set -euo pipefail
cd "$(dirname "$0")"

CHAIN="${1:-sepolia}"
SUBSYSTEM="${2:-phase1}"

case "$CHAIN" in
  mainnet)            CHAIN_ID=1        ; API_KEY="${ETHERSCAN_API_KEY:-}"                ; VERIFIER_URL="" ;;
  sepolia)            CHAIN_ID=11155111 ; API_KEY="${ETHERSCAN_API_KEY:-}"                ; VERIFIER_URL="" ;;
  base)               CHAIN_ID=8453     ; API_KEY="${BASESCAN_API_KEY:-}"                 ; VERIFIER_URL="https://api.basescan.org/api" ;;
  base-sepolia)       CHAIN_ID=84532    ; API_KEY="${BASESCAN_API_KEY:-}"                 ; VERIFIER_URL="https://api-sepolia.basescan.org/api" ;;
  robinhood)          CHAIN_ID=4663     ; API_KEY="${BLOCKSCOUT_API_KEY:-none}"           ; VERIFIER_URL="https://robinhoodchain.blockscout.com/api" ;;
  robinhood-testnet)  CHAIN_ID=46630    ; API_KEY="${BLOCKSCOUT_API_KEY:-none}"           ; VERIFIER_URL="https://robinhoodchain-testnet.blockscout.com/api" ;;
  *) echo "Unknown chain: $CHAIN"; exit 1 ;;
esac

if [[ -z "$API_KEY" ]]; then
  echo "Missing block-explorer API key for $CHAIN. Export the matching *_API_KEY env var."
  exit 1
fi

# Pick the address book that matches the subsystem being verified.
case "$SUBSYSTEM" in
  phase1)    BOOK="deployment.${CHAIN_ID}.json" ;;
  hooks)     BOOK="deployment-hooks.${CHAIN_ID}.json" ;;
  graduator) BOOK="deployment-graduator.${CHAIN_ID}.json" ;;
  flywheel)  BOOK="deployment-flywheel.${CHAIN_ID}.json" ;;
  *) echo "Unknown subsystem: $SUBSYSTEM (use phase1 | hooks | graduator | flywheel)"; exit 1 ;;
esac

if [[ ! -f "$BOOK" ]]; then
  echo "No address book at $BOOK. Broadcast the matching Deploy* script first."
  exit 1
fi

echo ">>> Verifying $SUBSYSTEM on $CHAIN (chain id $CHAIN_ID)"

verify() {
  local name="$1"
  local contractPath="$2"
  local addrKey="$3"
  local args="${4:-}"

  local addr
  addr=$(node -e "const b=require('./${BOOK}'); console.log(b.${addrKey} || '')")
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

case "$SUBSYSTEM" in
  phase1)
    verify "NameRegistry"    src/registry/NameRegistry.sol:NameRegistry NameRegistry
    verify "FeeReceiver"     src/router/FeeReceiver.sol:FeeReceiver FeeReceiver
    verify "Router"          src/router/Router.sol:Router Router
    verify "ERC20Factory"    src/factories/ERC20Factory.sol:ERC20Factory ERC20Factory
    verify "ERC20Template"   src/templates/ERC20Template.sol:ERC20Template ERC20TemplateImpl
    verify "ERC721AFactory"  src/factories/ERC721AFactory.sol:ERC721AFactory ERC721AFactory
    verify "ERC721ATemplate" src/templates/ERC721ATemplate.sol:ERC721ATemplate ERC721ATemplateImpl
    verify "ERC1155Factory"  src/factories/ERC1155Factory.sol:ERC1155Factory ERC1155Factory
    verify "ERC1155Template" src/templates/ERC1155Template.sol:ERC1155Template ERC1155TemplateImpl
    verify "BondingCurve"    src/curve/BondingCurve.sol:BondingCurve BondingCurveImpl
    verify "CurveFactory"    src/curve/CurveFactory.sol:CurveFactory CurveFactory
    ;;
  hooks)
    verify "LPLockedHook"    src/hooks/LPLockedHook.sol:LPLockedHook LPLockedHook
    verify "FeeRedirectHook" src/hooks/FeeRedirectHook.sol:FeeRedirectHook FeeRedirectHook
    verify "AntiSniperHook"  src/hooks/AntiSniperHook.sol:AntiSniperHook AntiSniperHook
    verify "MultiHookHost"   src/hooks/MultiHookHost.sol:MultiHookHost MultiHookHost
    verify "BuybackBurnHook" src/hooks/BuybackBurnHook.sol:BuybackBurnHook BuybackBurnHook
    ;;
  graduator)
    verify "Graduator"       src/curve/Graduator.sol:Graduator Graduator
    ;;
  flywheel)
    verify "FeeSplitter"          src/router/FeeSplitter.sol:FeeSplitter FeeSplitter
    verify "LoyaltyOracle"        src/flywheel/LoyaltyOracle.sol:LoyaltyOracle LoyaltyOracle
    verify "NftRevenueVault"      src/flywheel/NftRevenueVault.sol:NftRevenueVault NftRevenueVault
    verify "UruBuybackVault"      src/flywheel/UruBuybackVault.sol:UruBuybackVault UruBuybackVault
    verify "RoyaltyRouterImpl"    src/flywheel/RoyaltyRouterImpl.sol:RoyaltyRouterImpl RoyaltyRouterImpl
    verify "RoyaltyRouterFactory" src/flywheel/RoyaltyRouterFactory.sol:RoyaltyRouterFactory RoyaltyRouterFactory
    ;;
esac

echo ">>> Verification pass complete."
echo ">>> If any contract failed with 'BYTECODE_MISMATCH' or 'unknown creation code',"
echo ">>> pass constructor args manually — see the Deploy*.s.sol script for the exact"
echo ">>> ctor signature and the values it broadcast with."
