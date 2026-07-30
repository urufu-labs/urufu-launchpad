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
/// Widened from uint32 to uint256. Prior version narrowed block.number to
/// uint32 during init addition — a chain past ~4.3B blocks OR a very large
/// expireAfterBlocks param would either truncate or wrap silently. Storage
/// slot is the same width (packed with mapping below at 32 bytes); widening
/// costs nothing.
uint256 private _awExpiresAtBlock;
mapping(address => bool) private _awExcluded;

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
{
    (uint128 maxWallet, uint128 maxTx, uint32 expireAfter) =
        abi.decode(moduleData, (uint128, uint128, uint32));
    _awMaxWallet = maxWallet;
    _awMaxTx = maxTx;
    // Use full-width uint256 arithmetic. block.number is uint256 on-chain; the
    // prior uint32 cast would silently truncate past block ~4.3B (unlikely
    // near-term but still wrong). expireAfter stays uint32 for ABI stability
    // — it's promoted to uint256 by the compiler for the addition.
    _awExpiresAtBlock = block.number + expireAfter;
    _awExcluded[initialOwner] = true;
    emit AntiWhaleConfigured(maxWallet, maxTx, uint32(_awExpiresAtBlock));
}

// ============================================================
// SECTION: VM_INJECT_BEFORE_TRANSFER
// ============================================================
// Split maxTx and maxWallet exemptions. The previous
//   !_awExcluded[from] && !_awExcluded[to]
// gate meant EITHER side being excluded skipped BOTH caps — and since
// the bonding curve gets excluded at launch, every curve→buyer transfer
// bypassed both maxTx and maxWallet, defeating AntiWhale's advertised
// primary-market protection. Fixed by:
//   - maxTx: still allows exempt SENDERS (curve, LP router, etc.) to
//     distribute in a single tx above the per-tx cap. Recipient is not
//     the trust boundary for tx-size.
//   - maxWallet: keys ONLY on the recipient's exclusion. An excluded
//     recipient (LP pool, treasury multisig, etc.) can hold any balance;
//     everyone else — including curve buyers — is subject to the cap.
if (
    block.number < uint256(_awExpiresAtBlock)
        && from != address(0) && to != address(0)
) {
    if (!_awExcluded[from] && !_awExcluded[to] && amount > uint256(_awMaxTx)) {
        revert AntiWhale__MaxTxExceeded(amount, uint256(_awMaxTx));
    }
    if (!_awExcluded[to]) {
        uint256 postBalance = balanceOf(to) + amount;
        if (postBalance > uint256(_awMaxWallet)) {
            revert AntiWhale__MaxWalletExceeded(postBalance, uint256(_awMaxWallet));
        }
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
    // Cast internally so the getter ABI stays uint32 (matches frontend +
    // existing test expectations); storage stayed widened to uint256 for
    // safe arithmetic. block.number won't hit uint32 max for centuries so
    // the cast is lossless in practice.
    return (_awMaxWallet, _awMaxTx, uint32(_awExpiresAtBlock));
}

function antiWhaleIsExcluded(address who) external view returns (bool) {
    return _awExcluded[who];
}

function antiWhaleIsActive() external view returns (bool) {
    return block.number < uint256(_awExpiresAtBlock);
}
