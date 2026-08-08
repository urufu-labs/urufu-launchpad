SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c

ENV_FILE ?= .env.mainnet-rehearsal
PUBLIC_MAINNET_RPC ?= https://ethereum-rpc.publicnode.com
ACK_PHRASE := I_UNDERSTAND_THIS_SPENDS_MAINNET_ETH
CONFIRM_MAINNET ?=

CHECK_ENV = test -f "$(ENV_FILE)" || { echo "Missing $(ENV_FILE). Run: make env"; exit 1; }
LOAD_ENV = set -a; source "$(ENV_FILE)"; set +a
TINY_FEE_DEFAULTS = export ALLOW_MAINNET_TINY_FEES="$${ALLOW_MAINNET_TINY_FEES:-1}" ERC20_FEE_WEI="$${ERC20_FEE_WEI:-100000000000000}" NFT_FEE_WEI="$${NFT_FEE_WEI:-100000000000000}" ERC721A_FEE_WEI="$${ERC721A_FEE_WEI:-$${NFT_FEE_WEI}}" ERC1155_FEE_WEI="$${ERC1155_FEE_WEI:-$${NFT_FEE_WEI}}" MODULE_ADDON_WEI="$${MODULE_ADDON_WEI:-0}" HOOK_ADDON_WEI="$${HOOK_ADDON_WEI:-0}" GOV_ADDON_WEI="$${GOV_ADDON_WEI:-0}"
TINY_TARGET_DEFAULTS = export ALLOW_MAINNET_TINY_TARGET="$${ALLOW_MAINNET_TINY_TARGET:-1}" TARGET_ETH="$${TARGET_ETH:-1000000000000000}"
TINY_SMOKE_DEFAULTS = export SMOKE_BUY_WEI="$${SMOKE_BUY_WEI:-1000000000000000}" SMOKE_GRADUATE="$${SMOKE_GRADUATE:-0}"
REQUIRE_ACK = CONFIRM_MAINNET="$(CONFIRM_MAINNET)"; test "$${CONFIRM_MAINNET:-}" = "$(ACK_PHRASE)" || { echo "Refusing live mainnet broadcast."; echo "Re-run with: CONFIRM_MAINNET=$(ACK_PHRASE)"; exit 1; }
REQUIRE_BROADCAST_ENV = test -n "$${MAINNET_RPC_URL:-}" || { echo "MAINNET_RPC_URL is required in $(ENV_FILE)"; exit 1; }; test -n "$${DEV_PRIVATE_KEY:-}" || { echo "DEV_PRIVATE_KEY is required in $(ENV_FILE)"; exit 1; }; test -n "$${V4_POOL_MANAGER:-}" || { echo "V4_POOL_MANAGER is required in $(ENV_FILE)"; exit 1; }; test -n "$${URU_TOKEN_ADDRESS:-}" || { echo "URU_TOKEN_ADDRESS is required in $(ENV_FILE)"; exit 1; }; test -n "$${GEMU_NFT_ADDRESS:-}" || { echo "GEMU_NFT_ADDRESS is required in $(ENV_FILE)"; exit 1; }; test -n "$${MIN_URU_FEE:-}" || { echo "MIN_URU_FEE is required in $(ENV_FILE)"; exit 1; }; if [[ "$${SKIP_VERIFY:-0}" != "1" ]]; then test -n "$${ETHERSCAN_API_KEY:-}" || { echo "ETHERSCAN_API_KEY is required unless SKIP_VERIFY=1"; exit 1; }; fi

.PHONY: help env mainnet-address mainnet-balance mainnet-gas mainnet-rehearse-fresh mainnet-rehearse mainnet-live-preflight mainnet-deploy-fresh mainnet-lower-grad-target mainnet-smoke mainnet-live clean-dry-run
.NOTPARALLEL: mainnet-rehearse mainnet-live

help:
	@echo "Mainnet tiny rehearsal targets"
	@echo ""
	@echo "  make env                         Copy .env.mainnet-rehearsal.example to $(ENV_FILE)"
	@echo "  make mainnet-gas                 Read chain id, latest block, base fee, gas price"
	@echo "  make mainnet-address             Print burner address derived from DEV_PRIVATE_KEY"
	@echo "  make mainnet-balance             Print burner balance"
	@echo "  make mainnet-rehearse            No-broadcast fresh-stack fork rehearsal"
	@echo "  make mainnet-live-preflight      Check live env, confirmation, gas ceiling, balance"
	@echo "  make mainnet-live CONFIRM_MAINNET=$(ACK_PHRASE)"
	@echo "                                   Broadcast Fresh, lower target, then smoke"
	@echo "  make clean-dry-run               Delete ignored Foundry dry-run artifacts"

env:
	@test ! -e "$(ENV_FILE)" || { echo "$(ENV_FILE) already exists"; exit 0; }
	@cp .env.mainnet-rehearsal.example "$(ENV_FILE)"
	@echo "Created $(ENV_FILE). Fill MAINNET_RPC_URL, DEV_PRIVATE_KEY, URU_TOKEN_ADDRESS, and GEMU_NFT_ADDRESS before live targets."

mainnet-address:
	@$(CHECK_ENV)
	@$(LOAD_ENV); test -n "$${DEV_PRIVATE_KEY:-}" || { echo "DEV_PRIVATE_KEY is missing"; exit 1; }; cast wallet address --private-key "$$DEV_PRIVATE_KEY"

mainnet-balance:
	@$(CHECK_ENV)
	@$(LOAD_ENV); test -n "$${MAINNET_RPC_URL:-}" || { echo "MAINNET_RPC_URL is missing"; exit 1; }; test -n "$${DEV_PRIVATE_KEY:-}" || { echo "DEV_PRIVATE_KEY is missing"; exit 1; }; addr="$$(cast wallet address --private-key "$$DEV_PRIVATE_KEY")"; wei="$$(cast balance "$$addr" --rpc-url "$$MAINNET_RPC_URL")"; echo "$$addr"; echo "$$wei wei ($$(cast from-wei "$$wei" ether) ETH)"

mainnet-gas:
	@if [ -f "$(ENV_FILE)" ]; then $(LOAD_ENV); fi; rpc="$${MAINNET_RPC_URL:-$(PUBLIC_MAINNET_RPC)}"; echo "RPC: $$rpc"; echo "chain-id=$$(cast chain-id --rpc-url "$$rpc")"; echo "latest-block=$$(cast block latest --field number --rpc-url "$$rpc")"; echo "base-fee-wei=$$(cast base-fee --rpc-url "$$rpc")"; echo "gas-price-wei=$$(cast gas-price --rpc-url "$$rpc")"

mainnet-rehearse-fresh:
	@$(CHECK_ENV)
	@$(LOAD_ENV); export MAINNET_RPC_URL="$${MAINNET_RPC_URL:-$(PUBLIC_MAINNET_RPC)}"; $(TINY_FEE_DEFAULTS); cd contracts && bash rehearse-deploy.sh DeployFreshLocal mainnet

mainnet-rehearse: mainnet-rehearse-fresh

mainnet-live-preflight:
	@$(CHECK_ENV)
	@$(LOAD_ENV); $(REQUIRE_ACK); $(REQUIRE_BROADCAST_ENV); gas_price_wei="$$(cast gas-price --rpc-url "$$MAINNET_RPC_URL")"; max_wei="$$(cast to-wei "$${MAX_GAS_PRICE_GWEI:-2}" gwei)"; node -e 'const [gas,max]=process.argv.slice(1).map(BigInt); if (gas > max) { console.error("gas price " + gas + " exceeds max " + max); process.exit(1); } console.log("gas price ok: " + gas + " <= " + max);' "$$gas_price_wei" "$$max_wei"; addr="$$(cast wallet address --private-key "$$DEV_PRIVATE_KEY")"; balance_wei="$$(cast balance "$$addr" --rpc-url "$$MAINNET_RPC_URL")"; min_wei="$${MIN_BURNER_BALANCE_WEI:-30000000000000000}"; node -e 'const [bal,min]=process.argv.slice(1).map(BigInt); if (bal < min) { console.error("burner balance " + bal + " below min " + min); process.exit(1); } console.log("burner balance ok: " + bal + " >= " + min);' "$$balance_wei" "$$min_wei"; echo "burner=$$addr"

mainnet-deploy-fresh: mainnet-live-preflight
	@$(LOAD_ENV); $(TINY_FEE_DEFAULTS); cd contracts && bash deploy.sh Fresh mainnet

mainnet-lower-grad-target:
	@$(CHECK_ENV)
	@$(LOAD_ENV); $(REQUIRE_ACK); $(REQUIRE_BROADCAST_ENV); $(TINY_TARGET_DEFAULTS); cd contracts && bash deploy.sh LowerGradTarget mainnet

mainnet-smoke:
	@$(CHECK_ENV)
	@$(LOAD_ENV); $(REQUIRE_ACK); $(REQUIRE_BROADCAST_ENV); $(TINY_SMOKE_DEFAULTS); cd contracts && bash deploy.sh PostDeploySmoke mainnet

mainnet-live: mainnet-live-preflight mainnet-deploy-fresh mainnet-lower-grad-target mainnet-smoke

clean-dry-run:
	@find contracts/broadcast contracts/cache -path '*/dry-run/*' -type f -delete 2>/dev/null || true
	@find contracts -maxdepth 1 \( -name 'deployment.1.json' -o -name 'deployment-fresh.1.json' -o -name 'deployment-flywheel.1.json' -o -name 'deployment-routerv2.1.json' \) -delete
