// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/*
 *  ════════════════════════════════════════════════════════════════
 *
 *    ウ  urufu labs  ✯  tap tap launch
 *
 *  ════════════════════════════════════════════════════════════════
 *
 *    this token was deployed with urufu labs.  once graduation
 *    hits, liquidity locks forever  ❤  and every trade after
 *    that rewards urufu gemu nft holders.
 *
 *          ～  好き好き大好き  ～  launch ur own with urufu labs
 *
 *  ════════════════════════════════════════════════════════════════
 */

import {ERC20} from "solady/tokens/ERC20.sol";
import {Ownable} from "solady/auth/Ownable.sol";
// Pre-emptively pulled in for common module fragments. Unused-in-bare warnings are harmless.
import {MerkleProofLib} from "solady/utils/MerkleProofLib.sol";

/// @title  ERC20Template
/// @notice Bare ERC-20 base for the VM launchpad, cloneable via EIP-1167. Compile service
///         splices audited module fragments at the `VM_INJECT_*` markers below. The bare
///         template compiles and passes tests on its own — modules are additive.
/// @dev    See docs/SPEC-templates.md.
///         Marker convention: every `VM_INJECT_X` marker sits at the BOTTOM of its section,
///         so spliced module content is appended after any existing base content. This makes
///         storage layout safe by construction (base storage frozen; module storage appended).
contract ERC20WithAntiWhaleVestingGen is ERC20, Ownable {
    // ============================================================
    // Base errors — frozen
    // ============================================================
    error ERC20Template__AlreadyInitialized();
    error ERC20Template__ZeroOwner();

    // ============================================================
    // VM_INJECT_ERRORS
    // --- from AntiWhale.frag.sol ---
    error AntiWhale__MaxTxExceeded(uint256 amount, uint256 cap);
    error AntiWhale__MaxWalletExceeded(uint256 wouldBe, uint256 cap);

    // --- from Vesting.frag.sol ---
    error Vesting__ZeroBeneficiary();
    error Vesting__ZeroTotal();
    error Vesting__BadSchedule(uint64 cliff, uint64 end);
    error Vesting__NothingToRelease();
    // ============================================================
    // Modules append custom errors below this marker.

    // ============================================================
    // Base events — frozen
    // ============================================================
    event Initialized(string name, string symbol, address indexed initialOwner, uint256 initialSupply);

    // ============================================================
    // VM_INJECT_EVENTS
    // --- from AntiWhale.frag.sol ---
    event AntiWhaleConfigured(uint128 maxWallet, uint128 maxTx, uint32 expiresAtBlock);
    event AntiWhaleExcludedSet(address indexed who, bool excluded);

    // --- from Vesting.frag.sol ---
    event VestingConfigured(
        address indexed beneficiary, uint256 totalAmount, uint64 cliffTimestamp, uint64 endTimestamp
    );
    event VestingReleased(address indexed beneficiary, uint256 amount);
    // ============================================================
    // Modules append events below this marker.

    // ============================================================
    // Base storage — FROZEN LAYOUT (do not reorder)
    // ============================================================
    string private _name;
    string private _symbol;
    uint8 private _initialized;

    // ============================================================
    // VM_INJECT_STATE
    // --- from AntiWhale.frag.sol ---
    uint128 private _awMaxWallet;
    uint128 private _awMaxTx;
    /// Widened from uint32 to uint256. Prior version narrowed block.number to
    /// uint32 during init addition — a chain past ~4.3B blocks OR a very large
    /// expireAfterBlocks param would either truncate or wrap silently. Storage
    /// slot is the same width (packed with mapping below at 32 bytes); widening
    /// costs nothing.
    uint256 private _awExpiresAtBlock;
    mapping(address => bool) private _awExcluded;

    // --- from Vesting.frag.sol ---
    address private _vestBeneficiary;
    uint256 private _vestTotal;
    uint256 private _vestReleased;
    uint64 private _vestCliff;
    uint64 private _vestEnd;
    // ============================================================
    // Modules append storage variables below this marker. Solidity assigns slots by
    // declaration order → module slots are strictly after base slots.

    // ============================================================
    // VM_INJECT_CONSTANTS
    // ============================================================
    // Modules append constants / immutables below this marker.

    // ============================================================
    // ERC-20 metadata
    // ============================================================

    function name() public view virtual override returns (string memory) {
        return _name;
    }

    function symbol() public view virtual override returns (string memory) {
        return _symbol;
    }

    // ============================================================
    // Initialization — called once by the factory on the clone
    // ============================================================

    /// @notice Initialize the clone. Called exactly once, immediately after `cloneDeterministic`.
    /// @dev    Encoded input: `abi.encode(initialOwner, name, symbol, initialSupply, initialRecipient, moduleData)`.
    ///         Factory forces `initialOwner = router` so Router can dispatch to the launcher's
    ///         chosen `OwnershipMode` post-initialize. `moduleData` is opaque to the base and
    ///         gets decoded per-module at `VM_INJECT_INIT`.
    function initialize(
        bytes calldata data
    ) external {
        if (_initialized != 0) revert ERC20Template__AlreadyInitialized();
        _initialized = 1;

        (
            address initialOwner,
            string memory name_,
            string memory symbol_,
            uint256 initialSupply,
            address initialRecipient,
            bytes[] memory moduleData
        ) = abi.decode(data, (address, string, string, uint256, address, bytes[]));

        if (initialOwner == address(0)) revert ERC20Template__ZeroOwner();

        _name = name_;
        _symbol = symbol_;
        _initializeOwner(initialOwner);

        // Compute the mint destination once, before the mint itself. Modules that need
        // to reserve a slice of the initial supply for post-launch payouts (Airdrop,
        // Vesting, Staking) reference this local via `_transfer(mintTarget, address(this),
        // allocation)` in their VM_INJECT_INIT block — this is what makes reserve-backed
        // modules work on bonding-curve launches WITHOUT breaking the fixed-supply
        // invariant. The transfers happen sequentially so an over-allocation reverts
        // loudly the moment mintTarget runs dry (safety by construction).
        address mintTarget = initialRecipient == address(0) ? initialOwner : initialRecipient;

        if (initialSupply > 0) {
            _mint(mintTarget, initialSupply);
        }

        emit Initialized(name_, symbol_, initialOwner, initialSupply);

        // ============================================================
        // VM_INJECT_INIT
        // --- from AntiWhale.frag.sol ---
        {
            (uint128 maxWallet, uint128 maxTx, uint32 expireAfter) =
                abi.decode(moduleData[0], (uint128, uint128, uint32));
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

        // --- from Vesting.frag.sol ---
        {
            (address beneficiary_, uint256 total_, uint64 cliff_, uint64 end_) =
                abi.decode(moduleData[1], (address, uint256, uint64, uint64));
            if (beneficiary_ == address(0)) revert Vesting__ZeroBeneficiary();
            if (total_ == 0) revert Vesting__ZeroTotal();
            if (end_ <= cliff_) revert Vesting__BadSchedule(cliff_, end_);
            _vestBeneficiary = beneficiary_;
            _vestTotal = total_;
            _vestCliff = cliff_;
            _vestEnd = end_;
            // Reserve the vesting pool out of the initial supply. If the launcher over-allocated
            // (Σ module allocations > initialSupply), this reverts inside solady's _transfer
            // when mintTarget's balance underflows — safety by construction.
            _transfer(mintTarget, address(this), total_);
            emit VestingConfigured(beneficiary_, total_, cliff_, end_);
        }
        // ============================================================
        // Modules decode their slice of `moduleData` here and set state. Reserve-
        // backed modules also `_transfer(mintTarget, address(this), allocation)` here.
        moduleData; // silence unused-var warning in the bare template
        mintTarget; // silence unused-var warning when no reserve-backed modules are spliced in
    }

    // ============================================================
    // VM_INJECT_MODIFIERS
    // ============================================================
    // Modules append modifiers below this marker.

    // ============================================================
    // Transfer hooks — module injection points
    // ============================================================

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual override {
        (from, to, amount); // silence unused-var warnings in bare template
        // ============================================================
        // VM_INJECT_BEFORE_TRANSFER
        // --- from AntiWhale.frag.sol ---
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
        if (block.number < uint256(_awExpiresAtBlock) && from != address(0) && to != address(0)) {
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
        // Modules append before-transfer hook bodies below this marker.
    }

    function _afterTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual override {
        (from, to, amount);
        // ============================================================
        // VM_INJECT_AFTER_TRANSFER
        // ============================================================
        // Modules append after-transfer hook bodies below this marker.
    }

    // ============================================================
    // VM_INJECT_EXTERNAL
    // --- from AntiWhale.frag.sol ---
    function setAntiWhaleExcluded(
        address who,
        bool excluded
    ) external onlyOwner {
        _awExcluded[who] = excluded;
        emit AntiWhaleExcludedSet(who, excluded);
    }

    function antiWhaleConfig() external view returns (uint128 maxWallet, uint128 maxTx, uint32 expiresAtBlock) {
        // Cast internally so the getter ABI stays uint32 (matches frontend +
        // existing test expectations); storage stayed widened to uint256 for
        // safe arithmetic. block.number won't hit uint32 max for centuries so
        // the cast is lossless in practice.
        return (_awMaxWallet, _awMaxTx, uint32(_awExpiresAtBlock));
    }

    function antiWhaleIsExcluded(
        address who
    ) external view returns (bool) {
        return _awExcluded[who];
    }

    function antiWhaleIsActive() external view returns (bool) {
        return block.number < uint256(_awExpiresAtBlock);
    }

    // --- from Vesting.frag.sol ---
    function vestingReleasable() public view returns (uint256) {
        uint64 nowTs = uint64(block.timestamp);
        if (nowTs < _vestCliff) return 0;
        uint256 vested;
        if (nowTs >= _vestEnd) {
            vested = _vestTotal;
        } else {
            uint256 elapsed = nowTs - _vestCliff;
            uint256 duration = _vestEnd - _vestCliff;
            vested = (_vestTotal * elapsed) / duration;
        }
        return vested - _vestReleased;
    }

    function vestingRelease() external {
        uint256 amount = vestingReleasable();
        if (amount == 0) revert Vesting__NothingToRelease();
        _vestReleased += amount;
        // Reserve-backed: pay from the pre-allocated pool on address(this), NOT via _mint.
        // Total supply stays at whatever was minted in initialize() — no post-launch inflation.
        _transfer(address(this), _vestBeneficiary, amount);
        emit VestingReleased(_vestBeneficiary, amount);
    }

    function vestingBeneficiary() external view returns (address) {
        return _vestBeneficiary;
    }

    function vestingTotal() external view returns (uint256) {
        return _vestTotal;
    }

    function vestingReleased() external view returns (uint256) {
        return _vestReleased;
    }

    function vestingCliffTimestamp() external view returns (uint64) {
        return _vestCliff;
    }

    function vestingEndTimestamp() external view returns (uint64) {
        return _vestEnd;
    }
    // ============================================================
    // Modules append new external / public functions below this marker.

    // ============================================================
    // VM_INJECT_INTERNAL
    // ============================================================
    // Modules append internal helpers below this marker.
}
