// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "solady/auth/Ownable.sol";

/// @title  NameRegistry
/// @notice Global source of truth for reserved token names and tickers on the VM launchpad.
/// @dev    Reservations are permanent. Router-only writes for `reserve`; owner-only writes for
///         the reserved-ticker blocklist, router rotation, and treasury. See docs/SPEC-registry.md.
contract NameRegistry is Ownable {
    // ============================================================
    // Types
    // ============================================================

    struct Reservation {
        address token;
        address launchedBy;
        uint64 timestamp;
        uint32 chainId;
        string name;
        string ticker;
    }

    enum ValidationReason {
        Ok,
        InvalidCharacter,
        TooShort,
        TooLong,
        AlreadyTaken,
        Reserved
    }

    // ============================================================
    // Errors
    // ============================================================

    error NameRegistry__NotRouter();
    error NameRegistry__ZeroAddress();
    error NameRegistry__NameTaken(bytes32 nameHash);
    error NameRegistry__TickerTaken(bytes32 tickerHash);
    error NameRegistry__TickerReserved(bytes32 tickerHash);
    error NameRegistry__NameLength(uint256 len);
    error NameRegistry__TickerLength(uint256 len);
    error NameRegistry__InvalidNameChar();
    error NameRegistry__InvalidTickerChar();
    error NameRegistry__CannotReserveClaimedTicker(bytes32 tickerHash);
    error NameRegistry__CannotRemoveClaimedTicker(bytes32 tickerHash);

    // ============================================================
    // Events
    // ============================================================

    event Reserved(
        bytes32 indexed nameHash,
        bytes32 indexed tickerHash,
        address indexed token,
        address launchedBy,
        string name,
        string ticker,
        uint256 timestamp,
        uint256 chainId
    );
    event RouterSet(address indexed oldRouter, address indexed newRouter);
    event ReservedTickerAdded(bytes32 indexed tickerHash, string ticker);
    event ReservedTickerRemoved(bytes32 indexed tickerHash, string ticker);
    event TreasurySet(address indexed oldTreasury, address indexed newTreasury);

    // ============================================================
    // Constants
    // ============================================================

    uint256 private constant NAME_MIN_LEN = 1;
    uint256 private constant NAME_MAX_LEN = 32;
    uint256 private constant TICKER_MIN_LEN = 2;
    uint256 private constant TICKER_MAX_LEN = 10;

    // ============================================================
    // Storage
    // ============================================================

    address public router;
    address public treasury;

    mapping(bytes32 => Reservation) private _reservations;
    mapping(bytes32 => address) private _tickerOwner;
    mapping(bytes32 => bool) private _reservedTickers;

    // ============================================================
    // Constructor
    // ============================================================

    constructor(
        address initialOwner,
        address initialTreasury,
        string[] memory initialReservedTickers
    ) {
        _initializeOwner(initialOwner);
        treasury = initialTreasury;
        emit TreasurySet(address(0), initialTreasury);

        uint256 n = initialReservedTickers.length;
        for (uint256 i; i < n;) {
            _addReservedTicker(initialReservedTickers[i]);
            unchecked {
                ++i;
            }
        }
    }

    // ============================================================
    // External — Router-only
    // ============================================================

    /// @notice Reserve `name` and `ticker` for `token`, launched by `launchedBy`.
    /// @dev    Only callable by the Router. Reverts if either name or ticker is unavailable,
    ///         if characters or lengths violate the normalization rules, or if `token` is zero.
    /// @param  name        Human-readable token name (ASCII only, 1..32 chars post-trim, case-insensitive for
    /// uniqueness). @param  ticker      Market ticker (uppercase alphanumeric only, 2..10 chars).
    /// @param  token       Address of the token contract this reservation binds to.
    /// @param  launchedBy  Address that initiated the launch (recorded for provenance).
    /// @return nameHash    keccak256 of the lowercased-normalized name.
    /// @return tickerHash  keccak256 of the normalized (uppercase) ticker.
    function reserve(
        string calldata name,
        string calldata ticker,
        address token,
        address launchedBy
    ) external returns (bytes32 nameHash, bytes32 tickerHash) {
        if (msg.sender != router) revert NameRegistry__NotRouter();
        if (token == address(0)) revert NameRegistry__ZeroAddress();

        string memory normalizedName = _normalizeNameOrRevert(name);
        string memory normalizedTicker = _normalizeTickerOrRevert(ticker);

        nameHash = keccak256(bytes(_lowercase(normalizedName)));
        tickerHash = keccak256(bytes(normalizedTicker));

        if (_reservations[nameHash].token != address(0)) {
            revert NameRegistry__NameTaken(nameHash);
        }
        if (_tickerOwner[tickerHash] != address(0)) {
            revert NameRegistry__TickerTaken(tickerHash);
        }
        if (_reservedTickers[tickerHash]) {
            revert NameRegistry__TickerReserved(tickerHash);
        }

        _reservations[nameHash] = Reservation({
            token: token,
            launchedBy: launchedBy,
            timestamp: uint64(block.timestamp),
            chainId: uint32(block.chainid),
            name: normalizedName,
            ticker: normalizedTicker
        });
        _tickerOwner[tickerHash] = token;

        emit Reserved(
            nameHash, tickerHash, token, launchedBy, normalizedName, normalizedTicker, block.timestamp, block.chainid
        );
    }

    // ============================================================
    // Views — availability + validation
    // ============================================================

    /// @notice Returns true iff `name` is well-formed AND not already reserved.
    /// @dev    Non-reverting for invalid inputs (returns false).
    function isNameAvailable(
        string calldata name
    ) external view returns (bool) {
        (bool ok, string memory normalized,) = _validateNameChars(name);
        if (!ok) return false;
        return _reservations[keccak256(bytes(_lowercase(normalized)))].token == address(0);
    }

    /// @notice Returns true iff `ticker` is well-formed, not reserved, AND not already claimed.
    function isTickerAvailable(
        string calldata ticker
    ) external view returns (bool) {
        (bool ok, string memory normalized,) = _validateTickerChars(ticker);
        if (!ok) return false;
        bytes32 hash = keccak256(bytes(normalized));
        if (_reservedTickers[hash]) return false;
        return _tickerOwner[hash] == address(0);
    }

    /// @notice Full validation of `name` with a machine-readable reason enum.
    function validateName(
        string calldata name
    ) external view returns (bool valid, ValidationReason reason) {
        (bool ok, string memory normalized, ValidationReason r) = _validateNameChars(name);
        if (!ok) return (false, r);
        bytes32 hash = keccak256(bytes(_lowercase(normalized)));
        if (_reservations[hash].token != address(0)) {
            return (false, ValidationReason.AlreadyTaken);
        }
        return (true, ValidationReason.Ok);
    }

    /// @notice Full validation of `ticker` with a machine-readable reason enum.
    function validateTicker(
        string calldata ticker
    ) external view returns (bool valid, ValidationReason reason) {
        (bool ok, string memory normalized, ValidationReason r) = _validateTickerChars(ticker);
        if (!ok) return (false, r);
        bytes32 hash = keccak256(bytes(normalized));
        if (_reservedTickers[hash]) return (false, ValidationReason.Reserved);
        if (_tickerOwner[hash] != address(0)) return (false, ValidationReason.AlreadyTaken);
        return (true, ValidationReason.Ok);
    }

    /// @notice Returns the full reservation record for a given nameHash (zero-struct if unreserved).
    function reservationOf(
        bytes32 nameHash
    ) external view returns (Reservation memory) {
        return _reservations[nameHash];
    }

    /// @notice Returns the token address associated with a tickerHash (address(0) if unclaimed).
    function tickerOwner(
        bytes32 tickerHash
    ) external view returns (address) {
        return _tickerOwner[tickerHash];
    }

    /// @notice Returns true iff a tickerHash is on the reserved-ticker blocklist.
    function isTickerReserved(
        bytes32 tickerHash
    ) external view returns (bool) {
        return _reservedTickers[tickerHash];
    }

    // ============================================================
    // Admin — onlyOwner
    // ============================================================

    /// @notice Set (or rotate) the Router address. Recommend timelock in production.
    function setRouter(
        address newRouter
    ) external onlyOwner {
        emit RouterSet(router, newRouter);
        router = newRouter;
    }

    /// @notice Rotate the treasury address. Unused in v1 but wired for future sweeps.
    function setTreasury(
        address newTreasury
    ) external onlyOwner {
        emit TreasurySet(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice Add a ticker to the reserved-ticker blocklist.
    /// @dev    Reverts if the ticker is already claimed by a token, so invariant
    ///         "reserved implies unclaimed" holds by construction.
    function addReservedTicker(
        string calldata ticker
    ) external onlyOwner {
        _addReservedTicker(ticker);
    }

    /// @notice Remove a ticker from the reserved-ticker blocklist.
    /// @dev    Reverts if the ticker has been claimed since being added (defense in depth
    ///         under the invariant already enforced by `addReservedTicker`).
    function removeReservedTicker(
        string calldata ticker
    ) external onlyOwner {
        string memory normalized = _normalizeTickerOrRevert(ticker);
        bytes32 hash = keccak256(bytes(normalized));
        if (_tickerOwner[hash] != address(0)) {
            revert NameRegistry__CannotRemoveClaimedTicker(hash);
        }
        _reservedTickers[hash] = false;
        emit ReservedTickerRemoved(hash, normalized);
    }

    // ============================================================
    // Internal — normalization + validation
    // ============================================================

    function _addReservedTicker(
        string memory ticker
    ) internal {
        string memory normalized = _normalizeTickerOrRevert(ticker);
        bytes32 hash = keccak256(bytes(normalized));
        if (_tickerOwner[hash] != address(0)) {
            revert NameRegistry__CannotReserveClaimedTicker(hash);
        }
        _reservedTickers[hash] = true;
        emit ReservedTickerAdded(hash, normalized);
    }

    /// @dev Reverts with the specific length/character error. Used from write paths.
    function _normalizeNameOrRevert(
        string memory input
    ) internal pure returns (string memory) {
        (bool ok, string memory normalized, ValidationReason reason) = _validateNameChars(input);
        if (ok) return normalized;
        if (reason == ValidationReason.InvalidCharacter) revert NameRegistry__InvalidNameChar();
        revert NameRegistry__NameLength(bytes(normalized).length);
    }

    /// @dev Reverts with the specific length/character error. Used from write paths.
    function _normalizeTickerOrRevert(
        string memory input
    ) internal pure returns (string memory) {
        (bool ok, string memory normalized, ValidationReason reason) = _validateTickerChars(input);
        if (ok) return normalized;
        if (reason == ValidationReason.InvalidCharacter) revert NameRegistry__InvalidTickerChar();
        revert NameRegistry__TickerLength(bytes(input).length);
    }

    /// @dev Non-reverting core normalizer for names. Applies:
    ///         - trim leading/trailing spaces (0x20 only),
    ///         - collapse runs of spaces to a single space,
    ///         - accept ASCII [A-Za-z0-9 -_] only,
    ///         - post-normalize length must fall in [NAME_MIN_LEN, NAME_MAX_LEN].
    function _validateNameChars(
        string memory input
    ) internal pure returns (bool ok, string memory normalized, ValidationReason reason) {
        bytes memory raw = bytes(input);
        uint256 rlen = raw.length;

        // Trim leading spaces.
        uint256 start;
        while (start < rlen && raw[start] == 0x20) {
            unchecked {
                ++start;
            }
        }
        // Trim trailing spaces.
        uint256 end = rlen;
        while (end > start && raw[end - 1] == 0x20) {
            unchecked {
                --end;
            }
        }

        // Validate + collapse internal whitespace runs.
        // Worst-case output size = (end - start).
        bytes memory buf = new bytes(end - start);
        uint256 outLen;
        bool inSpace;
        for (uint256 i = start; i < end;) {
            bytes1 c = raw[i];
            if (c == 0x20) {
                if (!inSpace) {
                    buf[outLen] = c;
                    unchecked {
                        ++outLen;
                    }
                    inSpace = true;
                }
            } else if (_isValidNameChar(c)) {
                buf[outLen] = c;
                unchecked {
                    ++outLen;
                }
                inSpace = false;
            } else {
                return (false, "", ValidationReason.InvalidCharacter);
            }
            unchecked {
                ++i;
            }
        }

        if (outLen < NAME_MIN_LEN) return (false, "", ValidationReason.TooShort);
        if (outLen > NAME_MAX_LEN) {
            // Return the actual normalized (but too-long) length so the write-path can revert with it.
            bytes memory over = new bytes(outLen);
            for (uint256 i; i < outLen;) {
                over[i] = buf[i];
                unchecked {
                    ++i;
                }
            }
            return (false, string(over), ValidationReason.TooLong);
        }

        // Truncate buf to outLen.
        bytes memory result = new bytes(outLen);
        for (uint256 i; i < outLen;) {
            result[i] = buf[i];
            unchecked {
                ++i;
            }
        }
        return (true, string(result), ValidationReason.Ok);
    }

    /// @dev Non-reverting core normalizer for tickers. Ticker is uppercase alphanumeric only,
    ///      length in [TICKER_MIN_LEN, TICKER_MAX_LEN]. No trimming or case-fold.
    function _validateTickerChars(
        string memory input
    ) internal pure returns (bool ok, string memory normalized, ValidationReason reason) {
        bytes memory raw = bytes(input);
        uint256 rlen = raw.length;
        if (rlen < TICKER_MIN_LEN) return (false, "", ValidationReason.TooShort);
        if (rlen > TICKER_MAX_LEN) return (false, input, ValidationReason.TooLong);

        for (uint256 i; i < rlen;) {
            bytes1 c = raw[i];
            if (!_isValidTickerChar(c)) {
                return (false, "", ValidationReason.InvalidCharacter);
            }
            unchecked {
                ++i;
            }
        }
        return (true, input, ValidationReason.Ok);
    }

    /// @dev A-Z, a-z, 0-9, space, hyphen, underscore.
    function _isValidNameChar(
        bytes1 c
    ) internal pure returns (bool) {
        return (c >= 0x41 && c <= 0x5A) // A-Z
            || (c >= 0x61 && c <= 0x7A) // a-z
            || (c >= 0x30 && c <= 0x39) // 0-9
            || c == 0x20 // space
            || c == 0x2D // -
            || c == 0x5F; // _
    }

    /// @dev A-Z, 0-9 only. No lowercase, no separators.
    function _isValidTickerChar(
        bytes1 c
    ) internal pure returns (bool) {
        return (c >= 0x41 && c <= 0x5A) || (c >= 0x30 && c <= 0x39);
    }

    /// @dev Case-fold: any ASCII uppercase becomes lowercase. Other bytes pass through.
    function _lowercase(
        string memory s
    ) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 len = b.length;
        bytes memory out = new bytes(len);
        for (uint256 i; i < len;) {
            bytes1 c = b[i];
            if (c >= 0x41 && c <= 0x5A) {
                out[i] = bytes1(uint8(c) + 32);
            } else {
                out[i] = c;
            }
            unchecked {
                ++i;
            }
        }
        return string(out);
    }
}
