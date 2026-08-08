SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c

ENV_FILE ?= .env.robinhood-mainnet-rehearsal
PUBLIC_ROBINHOOD_RPC ?= https://rpc.mainnet.chain.robinhood.com
ACK_PHRASE := I_UNDERSTAND_THIS_SPENDS_ROBINHOOD_MAINNET_ETH
CONFIRM_MAINNET ?=

CHECK_ENV = test -f "$(ENV_FILE)" || { echo "Missing $(ENV_FILE). Run: make env"; exit 1; }
LOAD_ENV = set -a; source "$(ENV_FILE)"; set +a
TINY_FEE_DEFAULTS = export ALLOW_ROBINHOOD_MAINNET_TINY_FEES="$${ALLOW_ROBINHOOD_MAINNET_TINY_FEES:-1}" ERC20_FEE_WEI="$${ERC20_FEE_WEI:-100000000000000}" NFT_FEE_WEI="$${NFT_FEE_WEI:-100000000000000}" ERC721A_FEE_WEI="$${ERC721A_FEE_WEI:-$${NFT_FEE_WEI}}" ERC1155_FEE_WEI="$${ERC1155_FEE_WEI:-$${NFT_FEE_WEI}}" MODULE_ADDON_WEI="$${MODULE_ADDON_WEI:-0}" HOOK_ADDON_WEI="$${HOOK_ADDON_WEI:-0}" GOV_ADDON_WEI="$${GOV_ADDON_WEI:-0}"
TINY_TARGET_DEFAULTS = export ALLOW_ROBINHOOD_MAINNET_TINY_TARGET="$${ALLOW_ROBINHOOD_MAINNET_TINY_TARGET:-1}" TARGET_ETH="$${TARGET_ETH:-1000000000000000}"
TINY_SMOKE_DEFAULTS = export SMOKE_BUY_WEI="$${SMOKE_BUY_WEI:-1000000000000000}" SMOKE_GRADUATE="$${SMOKE_GRADUATE:-0}"
REQUIRE_ACK = CONFIRM_MAINNET="$(CONFIRM_MAINNET)"; test "$${CONFIRM_MAINNET:-}" = "$(ACK_PHRASE)" || { echo "Refusing live Robinhood mainnet broadcast."; echo "Re-run with: CONFIRM_MAINNET=$(ACK_PHRASE)"; exit 1; }
REQUIRE_BROADCAST_ENV = test -n "$${ROBINHOOD_RPC_URL:-}" || { echo "ROBINHOOD_RPC_URL is required in $(ENV_FILE)"; exit 1; }; test -n "$${DEV_PRIVATE_KEY:-}" || { echo "DEV_PRIVATE_KEY is required in $(ENV_FILE)"; exit 1; }; test -n "$${V4_POOL_MANAGER:-}" || { echo "V4_POOL_MANAGER is required in $(ENV_FILE)"; exit 1; }; test -n "$${URU_TOKEN_ADDRESS:-}" || { echo "URU_TOKEN_ADDRESS is required in $(ENV_FILE)"; exit 1; }; test -n "$${GEMU_NFT_ADDRESS:-}" || { echo "GEMU_NFT_ADDRESS is required in $(ENV_FILE)"; exit 1; }; test -n "$${MIN_URU_FEE:-}" || { echo "MIN_URU_FEE is required in $(ENV_FILE)"; exit 1; }
REQUIRE_ROBINHOOD_CHAIN = chain_id="$$(cast chain-id --rpc-url "$${ROBINHOOD_RPC_URL:-$(PUBLIC_ROBINHOOD_RPC)}")"; test "$$chain_id" = "4663" || { echo "RPC resolved to chain-id $$chain_id; expected Robinhood mainnet chain-id 4663"; exit 1; }

.PHONY: help env rh-mainnet-address rh-mainnet-balance rh-mainnet-gas rh-mainnet-rehearse-fresh rh-mainnet-rehearse rh-mainnet-live-preflight rh-mainnet-deploy-fresh rh-mainnet-lower-grad-target rh-mainnet-smoke rh-mainnet-live mainnet-address mainnet-balance mainnet-gas mainnet-rehearse mainnet-live-preflight mainnet-deploy-fresh mainnet-lower-grad-target mainnet-smoke mainnet-live clean-dry-run
.NOTPARALLEL: rh-mainnet-rehearse rh-mainnet-live mainnet-rehearse mainnet-live

help:
	@echo "Robinhood mainnet tiny rehearsal targets"
	@echo ""
	@echo "  make env                              Copy .env.robinhood-mainnet-rehearsal.example to $(ENV_FILE)"
	@echo "  make rh-mainnet-gas                  Read chain id, latest block, base fee, gas price"
	@echo "  make rh-mainnet-address              Print burner address derived from DEV_PRIVATE_KEY"
	@echo "  make rh-mainnet-balance              Print burner balance"
	@echo "  make rh-mainnet-rehearse             No-broadcast fresh-stack fork rehearsal on chain 4663"
	@echo "  make rh-mainnet-live-preflight       Check env, chain id, confirmation, gas ceiling, balance"
	@echo "  make rh-mainnet-live CONFIRM_MAINNET=$(ACK_PHRASE)"
	@echo "                                      Broadcast Fresh, lower target, then smoke"
	@echo "  make clean-dry-run                   Delete ignored Foundry dry-run artifacts"
	@echo ""
	@echo "  mainnet-* aliases point to Robinhood mainnet in this branch."

env:
	@test ! -e "$(ENV_FILE)" || { echo "$(ENV_FILE) already exists"; exit 0; }
	@cp .env.robinhood-mainnet-rehearsal.example "$(ENV_FILE)"
	@echo "Created $(ENV_FILE). Fill DEV_PRIVATE_KEY before live targets."

rh-mainnet-address:
	@$(CHECK_ENV)
	@$(LOAD_ENV); test -n "$${DEV_PRIVATE_KEY:-}" || { echo "DEV_PRIVATE_KEY is missing"; exit 1; }; cast wallet address --private-key "$$DEV_PRIVATE_KEY"

rh-mainnet-balance:
	@$(CHECK_ENV)
	@$(LOAD_ENV); test -n "$${ROBINHOOD_RPC_URL:-}" || { echo "ROBINHOOD_RPC_URL is missing"; exit 1; }; test -n "$${DEV_PRIVATE_KEY:-}" || { echo "DEV_PRIVATE_KEY is missing"; exit 1; }; $(REQUIRE_ROBINHOOD_CHAIN); addr="$$(cast wallet address --private-key "$$DEV_PRIVATE_KEY")"; wei="$$(cast balance "$$addr" --rpc-url "$$ROBINHOOD_RPC_URL")"; echo "$$addr"; echo "$$wei wei ($$(cast from-wei "$$wei" ether) ETH)"

rh-mainnet-gas:
	@if [ -f "$(ENV_FILE)" ]; then $(LOAD_ENV); fi; rpc="$${ROBINHOOD_RPC_URL:-$(PUBLIC_ROBINHOOD_RPC)}"; echo "RPC: $$rpc"; echo "chain-id=$$(cast chain-id --rpc-url "$$rpc")"; echo "latest-block=$$(cast block latest --field number --rpc-url "$$rpc")"; echo "base-fee-wei=$$(cast base-fee --rpc-url "$$rpc")"; echo "gas-price-wei=$$(cast gas-price --rpc-url "$$rpc")"

rh-mainnet-rehearse-fresh:
	@$(CHECK_ENV)
	@$(LOAD_ENV); export ROBINHOOD_RPC_URL="$${ROBINHOOD_RPC_URL:-$(PUBLIC_ROBINHOOD_RPC)}"; $(REQUIRE_ROBINHOOD_CHAIN); $(TINY_FEE_DEFAULTS); cd contracts && trap 'rm -f deployment.4663.json deployment-fresh.4663.json deployment-flywheel.4663.json deployment-routerv2.4663.json' EXIT; forge test --match-path test/audit/DeployPathRhFork.t.sol --match-test test_FreshDeploy_RunsCleanAgainstLiveRhFork -vvv

rh-mainnet-rehearse: rh-mainnet-rehearse-fresh

rh-mainnet-live-preflight:
	@$(CHECK_ENV)
	@$(LOAD_ENV); $(REQUIRE_ACK); $(REQUIRE_BROADCAST_ENV); $(REQUIRE_ROBINHOOD_CHAIN); gas_price_wei="$$(cast gas-price --rpc-url "$$ROBINHOOD_RPC_URL")"; max_wei="$$(cast to-wei "$${MAX_GAS_PRICE_GWEI:-2}" gwei)"; node -e 'const [gas,max]=process.argv.slice(1).map(BigInt); if (gas > max) { console.error("gas price " + gas + " exceeds max " + max); process.exit(1); } console.log("gas price ok: " + gas + " <= " + max);' "$$gas_price_wei" "$$max_wei"; addr="$$(cast wallet address --private-key "$$DEV_PRIVATE_KEY")"; balance_wei="$$(cast balance "$$addr" --rpc-url "$$ROBINHOOD_RPC_URL")"; min_wei="$${MIN_BURNER_BALANCE_WEI:-30000000000000000}"; node -e 'const [bal,min]=process.argv.slice(1).map(BigInt); if (bal < min) { console.error("burner balance " + bal + " below min " + min); process.exit(1); } console.log("burner balance ok: " + bal + " >= " + min);' "$$balance_wei" "$$min_wei"; echo "burner=$$addr"

rh-mainnet-deploy-fresh: rh-mainnet-live-preflight
	@$(LOAD_ENV); $(TINY_FEE_DEFAULTS); cd contracts && bash deploy.sh Fresh robinhood

rh-mainnet-lower-grad-target:
	@$(CHECK_ENV)
	@$(LOAD_ENV); $(REQUIRE_ACK); $(REQUIRE_BROADCAST_ENV); $(REQUIRE_ROBINHOOD_CHAIN); $(TINY_TARGET_DEFAULTS); cd contracts && bash deploy.sh LowerGradTarget robinhood

rh-mainnet-smoke:
	@$(CHECK_ENV)
	@$(LOAD_ENV); $(REQUIRE_ACK); $(REQUIRE_BROADCAST_ENV); $(REQUIRE_ROBINHOOD_CHAIN); $(TINY_SMOKE_DEFAULTS); cd contracts && bash deploy.sh PostDeploySmoke robinhood

rh-mainnet-live: rh-mainnet-live-preflight rh-mainnet-deploy-fresh rh-mainnet-lower-grad-target rh-mainnet-smoke

mainnet-address: rh-mainnet-address
mainnet-balance: rh-mainnet-balance
mainnet-gas: rh-mainnet-gas
mainnet-rehearse-fresh: rh-mainnet-rehearse-fresh
mainnet-rehearse: rh-mainnet-rehearse
mainnet-live-preflight: rh-mainnet-live-preflight
mainnet-deploy-fresh: rh-mainnet-deploy-fresh
mainnet-lower-grad-target: rh-mainnet-lower-grad-target
mainnet-smoke: rh-mainnet-smoke
mainnet-live: rh-mainnet-live

clean-dry-run:
	@find contracts/broadcast contracts/cache -path '*/dry-run/*' -type f -delete 2>/dev/null || true
	@find contracts -maxdepth 1 \( -name 'deployment.4663.json' -o -name 'deployment-fresh.4663.json' -o -name 'deployment-flywheel.4663.json' -o -name 'deployment-routerv2.4663.json' \) -delete
