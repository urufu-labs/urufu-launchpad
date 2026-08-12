#!/usr/bin/env bash
# Batch-verify every live RH contract on Blockscout with 90s spacing so we
# don't trip the public-instance rate limit. Idempotent — reruns skip
# already-verified contracts. Save as script/verify-all-rh.sh, chmod +x,
# then `bash contracts/script/verify-all-rh.sh` from repo root.
#
# Requires: BLOCKSCOUT_API_KEY env var (any value, ignored). Use "unused".

set -u
export BLOCKSCOUT_API_KEY="${BLOCKSCOUT_API_KEY:-unused}"
BS_URL="https://robinhoodchain.blockscout.com/api"
DELAY="${VERIFY_DELAY:-90}"

verify() {
  local name=$1 addr=$2 src=$3 encoded=$4
  echo ""
  echo "────────── $name ──────────"
  local out
  out=$(forge verify-contract "$addr" "$src" \
    --chain-id 4663 --verifier blockscout --verifier-url "$BS_URL" \
    --constructor-args "$encoded" --compiler-version "0.8.26" \
    --skip-is-verified-check --watch 2>&1)
  local summary
  summary=$(echo "$out" | grep -oE "(Pass - Verified|Fail - Unable[^\.]*|already verified|Too many requests|Unable to locate)" | head -1)
  echo "  $addr → ${summary:-unknown status}"
  echo "  cooldown ${DELAY}s..."
  sleep "$DELAY"
}

cd "$(dirname "$0")/.."

verify "CurveFactory" 0xEC96D023426167e68598FF9ea946882b7f0AE91f "src/curve/CurveFactory.sol:CurveFactory" \
  "$(cast abi-encode "constructor(address,address,address)" 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA 0x616462099AE1a40DA8327D2af2797c540507DBB2)"

verify "GraduatorV3" 0xB5aA5Fb4863Fe11ea7BdD6Deaf44004A09BD0C23 "src/curve/GraduatorV3.sol:GraduatorV3" \
  "$(cast abi-encode "constructor(address,address,uint24,int24,address,address)" 0x8366a39CC670B4001A1121B8F6A443A643e40951 0x83d6fa59BEF503112887b16277CF559fDC93E0C4 3000 60 0xEC96D023426167e68598FF9ea946882b7f0AE91f 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9)"

verify "GraduatorV2" 0xA29Ee1DB0a7C53e4733092C46C00d09feb1dFFC1 "src/curve/GraduatorV2.sol:GraduatorV2" \
  "$(cast abi-encode "constructor(address,address,uint24,int24,address,address)" 0x8366a39CC670B4001A1121B8F6A443A643e40951 0x48C22af8Ad989fc9d5e82D6055dc0F263076e0C4 3000 60 0xEC96D023426167e68598FF9ea946882b7f0AE91f 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9)"

verify "FeeSplitter" 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA "src/router/FeeSplitter.sol:FeeSplitter" \
  "$(cast abi-encode "constructor(address,address,uint256)" 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9 172800)"

verify "NftRevenueVault" 0x375337c4c3B85a44948e7D98d7C05256DEFf0eA8 "src/flywheel/NftRevenueVault.sol:NftRevenueVault" \
  "$(cast abi-encode "constructor(address,uint256)" 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9 172800)"

verify "UruBuybackVault" 0x68c5Ec467027fCe56f158eB1ff34cF89d0929354 "src/flywheel/UruBuybackVault.sol:UruBuybackVault" \
  "$(cast abi-encode "constructor(address,address,address,uint256)" 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9 0x9fbe210007dDd8389f98d0253018e65CC48b9D24 0x93CFF459d5019eEc82fE9335013e265F1eD659c7 172800)"

verify "UruDepositSink" 0xeCD30ea7d0945A99b2032af4A6ad9d5bF345B8C8 "src/router/UruDepositSink.sol:UruDepositSink" \
  "$(cast abi-encode "constructor(address,address,address,uint256)" 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9 0x9fbe210007dDd8389f98d0253018e65CC48b9D24 0x60835C422a3671b5F01E6806Fd96b27c90941C83 172800)"

verify "BondingCurve_impl" 0x616462099AE1a40DA8327D2af2797c540507DBB2 "src/curve/BondingCurve.sol:BondingCurve" "0x"

verify "ERC20Factory" 0xfCfE7Db4F4d4ed6CC2fa6143a8C163Da11246f99 "src/factories/ERC20Factory.sol:ERC20Factory" \
  "$(cast abi-encode "constructor(address,address,address)" 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9 0xb41e0Bd37D4EF19A7bd2cCEacc13CbbcD8339269 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9)"

verify "Router" 0xb41e0Bd37D4EF19A7bd2cCEacc13CbbcD8339269 "src/router/Router.sol:Router" \
  "$(cast abi-encode "constructor(address,address,address,uint256,uint256,uint256,uint256,uint256,uint256)" 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9 0x965Aa2420635Ca0431888c6752b9aE8Bbe8d1F05 0x60835C422a3671b5F01E6806Fd96b27c90941C83 50000000000000000 50000000000000000 50000000000000000 10000000000000000 10000000000000000 10000000000000000)"

echo ""
echo "==== DONE ===="
