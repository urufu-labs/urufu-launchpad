#!/usr/bin/env bash
# Install Foundry deps. Run once from repo root or contracts/.
#
# Uses forge 1.5+ flag syntax: --no-git (skip submodule tracking).
# Uniswap v4 versions are intentionally left as TODOs — the correct audited commit
# gets pinned when Phase 2 (curve + graduation) starts. Do NOT track main.

set -euo pipefail
cd "$(dirname "$0")"

# forge-std — testing library (needed for NameRegistry.t.sol onward)
forge install --no-git foundry-rs/forge-std

# Solady — Ownable, ReentrancyGuard, SafeTransferLib, FixedPointMathLib, LibClone (needed from NameRegistry onward)
forge install --no-git Vectorized/solady

# ERC721A (Chiru Labs) — gas-optimized NFT base
forge install --no-git chiru-labs/ERC721A

# --- Phase 1 deps (uncomment when writing templates/modules that need them) ---
# OpenZeppelin 5.x — ERC20Votes, Governor, TimelockController, AccessControl
# forge install --no-git OpenZeppelin/openzeppelin-contracts
# forge install --no-git OpenZeppelin/openzeppelin-contracts-upgradeable

# --- Phase 2 deps (curve + v4 graduation) ---
# Uniswap v4: pin exact commit before uncommenting.
# forge install --no-git Uniswap/v4-core@<COMMIT>
# forge install --no-git Uniswap/v4-periphery@<COMMIT>

echo ""
echo "Installed. Verify with: forge build"
