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
import {ERC20Votes} from "solady/tokens/ERC20Votes.sol";
import {Ownable} from "solady/auth/Ownable.sol";
// Pre-emptively pulled in for common module fragments.
import {MerkleProofLib} from "solady/utils/MerkleProofLib.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

/// @title  ERC20VotesTemplate
/// @notice ERC-5805-compatible ERC-20 base for the VM launchpad. Identical shape to
///         `ERC20Template` but inherits Solady `ERC20Votes` so checkpoint tracking is on
///         every transfer. Chosen as the base for any launch that stacks the `Votes` module
///         (and, downstream, `GovernorBundle`). Splicer marker convention is unchanged.
/// @dev    Storage layout is base-frozen. `_afterTokenTransfer` calls `super._afterTokenTransfer`
///         so vote checkpointing runs BEFORE any spliced after-transfer hooks — modules that
///         also add after-transfer logic (e.g. FeeOnTransfer) run their bodies afterward.
contract ERC20WithAntiWhaleVotesGen is ERC20Votes, Ownable {
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
    // ============================================================

    // ============================================================
    // Base events — frozen
    // ============================================================
    event Initialized(string name, string symbol, address indexed initialOwner, uint256 initialSupply);

    // ============================================================
    // VM_INJECT_EVENTS
    // --- from AntiWhale.frag.sol ---
    event AntiWhaleConfigured(uint128 maxWallet, uint128 maxTx, uint32 expiresAtBlock);
    event AntiWhaleExcludedSet(address indexed who, bool excluded);

    // --- from Votes.frag.sol ---
    event VotesEnabled();
    // ============================================================

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
    // ============================================================

    // ============================================================
    // VM_INJECT_CONSTANTS
    // ============================================================

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

        // Compute the mint destination once. Fragments reference `mintTarget` when they
        // need to reserve a slice of the initial supply for post-launch payouts (see
        // ERC20Template.sol for the pattern explanation).
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

        // --- from Votes.frag.sol ---
        {
            moduleData[1];
            emit VotesEnabled();
        }
        // ============================================================
        moduleData;
        mintTarget;
    }

    // ============================================================
    // VM_INJECT_MODIFIERS
    // ============================================================

    // ============================================================
    // Transfer hooks — module injection points
    // ============================================================

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual override {
        (from, to, amount);
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
    }

    function _afterTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual override {
        // ERC20Votes checkpointing must run every transfer — do NOT reorder or drop this.
        super._afterTokenTransfer(from, to, amount);
        // ============================================================
        // VM_INJECT_AFTER_TRANSFER
        // ============================================================
    }

    // ============================================================
    // OZ IVotes shim — OZ Governor calls `getPastTotalSupply(t)`; Solady names it
    // `getPastVotesTotalSupply(t)`. Forward one to the other so the token is a drop-in
    // votes source for `VMGovernor`.
    // ============================================================
    function getPastTotalSupply(
        uint256 timepoint
    ) external view returns (uint256) {
        return getPastVotesTotalSupply(timepoint);
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
    // ============================================================

    // ============================================================
    // VM_INJECT_INTERNAL
    // ============================================================
}
