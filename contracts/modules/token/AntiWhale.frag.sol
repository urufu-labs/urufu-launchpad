// SPDX-License-Identifier: MIT
// VM_MODULE_ID: AntiWhale
// VM_MODULE_VERSION: 1
// VM_MODULE_BASES: ERC20
// VM_MODULE_REQUIRES:
// VM_MODULE_INCOMPATIBLE_WITH:
// VM_MODULE_FLAGGED:
//
// Anti-whale caps. Enforces per-tx maximum + per-wallet maximum for N blocks after launch,
// then auto-expires. Owner and admin-added addresses (like LP pools) are exempt.
//
// Params: (uint128 maxWallet, uint128 maxTx, uint32 expireAfterBlocks)

// ============================================================
// SECTION: VM_INJECT_ERRORS
// ============================================================
error AntiWhale__MaxTxExceeded(uint256 amount, uint256 cap);
error AntiWhale__MaxWalletExceeded(uint256 wouldBe, uint256 cap);

// ============================================================
// SECTION: VM_INJECT_EVENTS
// ============================================================
event AntiWhaleConfigured(uint128 maxWallet, uint128 maxTx, uint32 expiresAtBlock);
event AntiWhaleExcludedSet(address indexed who, bool excluded);

// ============================================================
// SECTION: VM_INJECT_STATE
// ============================================================
uint128 private _awMaxWallet;
uint128 private _awMaxTx;
uint32 private _awExpiresAtBlock;
mapping(address => bool) private _awExcluded;

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
{
    (uint128 maxWallet, uint128 maxTx, uint32 expireAfter) =
        abi.decode(moduleData, (uint128, uint128, uint32));
    _awMaxWallet = maxWallet;
    _awMaxTx = maxTx;
    _awExpiresAtBlock = uint32(block.number) + expireAfter;
    _awExcluded[initialOwner] = true;
    emit AntiWhaleConfigured(maxWallet, maxTx, _awExpiresAtBlock);
}

// ============================================================
// SECTION: VM_INJECT_BEFORE_TRANSFER
// ============================================================
// Skip if past expiry OR mint/burn OR either side excluded.
if (
    block.number < uint256(_awExpiresAtBlock)
        && from != address(0) && to != address(0)
        && !_awExcluded[from] && !_awExcluded[to]
) {
    if (amount > uint256(_awMaxTx)) {
        revert AntiWhale__MaxTxExceeded(amount, uint256(_awMaxTx));
    }
    uint256 postBalance = balanceOf(to) + amount;
    if (postBalance > uint256(_awMaxWallet)) {
        revert AntiWhale__MaxWalletExceeded(postBalance, uint256(_awMaxWallet));
    }
}

// ============================================================
// SECTION: VM_INJECT_EXTERNAL
// ============================================================
function setAntiWhaleExcluded(address who, bool excluded) external onlyOwner {
    _awExcluded[who] = excluded;
    emit AntiWhaleExcludedSet(who, excluded);
}

function antiWhaleConfig()
    external
    view
    returns (uint128 maxWallet, uint128 maxTx, uint32 expiresAtBlock)
{
    return (_awMaxWallet, _awMaxTx, _awExpiresAtBlock);
}

function antiWhaleIsExcluded(address who) external view returns (bool) {
    return _awExcluded[who];
}

function antiWhaleIsActive() external view returns (bool) {
    return block.number < uint256(_awExpiresAtBlock);
}
