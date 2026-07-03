// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";

contract NameRegistryTest is Test {
    NameRegistry internal registry;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal router = makeAddr("router");
    address internal token = makeAddr("token");
    address internal launcher = makeAddr("launcher");
    address internal stranger = makeAddr("stranger");

    // Solady Ownable error (v0.0.x, thrown by _checkOwner).
    bytes4 internal constant UNAUTHORIZED_SELECTOR = 0x82b42900; // bytes4(keccak256("Unauthorized()"))

    function setUp() public {
        string[] memory reserved = new string[](4);
        reserved[0] = "ETH";
        reserved[1] = "USDC";
        reserved[2] = "WBTC";
        reserved[3] = "PEPE";

        registry = new NameRegistry(owner, treasury, reserved);

        vm.prank(owner);
        registry.setRouter(router);
    }

    // =========================================================
    // Reserve — happy path
    // =========================================================

    function test_Reserve_HappyPath_StoresRecord() public {
        vm.prank(router);
        (bytes32 nameHash, bytes32 tickerHash) = registry.reserve("Vending Machine Token", "VMT", token, launcher);

        NameRegistry.Reservation memory r = registry.reservationOf(nameHash);
        assertEq(r.token, token);
        assertEq(r.launchedBy, launcher);
        assertEq(r.name, "Vending Machine Token");
        assertEq(r.ticker, "VMT");
        assertEq(r.timestamp, uint64(block.timestamp));
        assertEq(r.chainId, uint32(block.chainid));
        assertEq(registry.tickerOwner(tickerHash), token);
    }

    function test_Reserve_EmitsReservedEvent() public {
        bytes32 expectedNameHash = keccak256(bytes("vending machine token"));
        bytes32 expectedTickerHash = keccak256(bytes("VMT"));

        vm.prank(router);
        vm.expectEmit(true, true, true, true, address(registry));
        emit NameRegistry.Reserved(
            expectedNameHash,
            expectedTickerHash,
            token,
            launcher,
            "Vending Machine Token",
            "VMT",
            block.timestamp,
            block.chainid
        );
        registry.reserve("Vending Machine Token", "VMT", token, launcher);
    }

    // =========================================================
    // Reserve — revert branches
    // =========================================================

    function test_Reserve_RevertsIfNotRouter() public {
        vm.expectRevert(NameRegistry.NameRegistry__NotRouter.selector);
        vm.prank(stranger);
        registry.reserve("Some Name", "SOME", token, launcher);
    }

    function test_Reserve_RevertsOnZeroToken() public {
        vm.expectRevert(NameRegistry.NameRegistry__ZeroAddress.selector);
        vm.prank(router);
        registry.reserve("Some Name", "SOME", address(0), launcher);
    }

    function test_Reserve_RevertsOnNameTaken() public {
        vm.prank(router);
        registry.reserve("Duplicate", "DUP1", token, launcher);

        bytes32 nameHash = keccak256(bytes("duplicate"));
        vm.expectRevert(abi.encodeWithSelector(NameRegistry.NameRegistry__NameTaken.selector, nameHash));
        vm.prank(router);
        registry.reserve("Duplicate", "DUP2", makeAddr("token2"), launcher);
    }

    function test_Reserve_RevertsOnTickerTaken() public {
        vm.prank(router);
        registry.reserve("First", "TAKEN", token, launcher);

        bytes32 tickerHash = keccak256(bytes("TAKEN"));
        vm.expectRevert(abi.encodeWithSelector(NameRegistry.NameRegistry__TickerTaken.selector, tickerHash));
        vm.prank(router);
        registry.reserve("Second", "TAKEN", makeAddr("token2"), launcher);
    }

    function test_Reserve_RevertsOnReservedTicker() public {
        bytes32 tickerHash = keccak256(bytes("USDC"));
        vm.expectRevert(abi.encodeWithSelector(NameRegistry.NameRegistry__TickerReserved.selector, tickerHash));
        vm.prank(router);
        registry.reserve("Fake USDC", "USDC", token, launcher);
    }

    function test_Reserve_RevertsOnNonAsciiName() public {
        vm.expectRevert(NameRegistry.NameRegistry__InvalidNameChar.selector);
        vm.prank(router);
        registry.reserve(unicode"Coca-Cöla", "COKE", token, launcher);
    }

    function test_Reserve_RevertsOnEmptyName() public {
        vm.expectRevert(abi.encodeWithSelector(NameRegistry.NameRegistry__NameLength.selector, uint256(0)));
        vm.prank(router);
        registry.reserve("", "TICK", token, launcher);
    }

    function test_Reserve_RevertsOnAllWhitespaceName() public {
        // Trims to empty → TooShort → NameLength(0).
        vm.expectRevert(abi.encodeWithSelector(NameRegistry.NameRegistry__NameLength.selector, uint256(0)));
        vm.prank(router);
        registry.reserve("     ", "TICK", token, launcher);
    }

    function test_Reserve_RevertsOnTooLongName() public {
        // 33 chars post-trim.
        string memory tooLong = "abcdefghijklmnopqrstuvwxyz1234567";
        vm.expectRevert(abi.encodeWithSelector(NameRegistry.NameRegistry__NameLength.selector, uint256(33)));
        vm.prank(router);
        registry.reserve(tooLong, "TICK", token, launcher);
    }

    function test_Reserve_AcceptsExactly32CharName() public {
        // 32 chars — at the boundary, should succeed.
        string memory atLimit = "abcdefghijklmnopqrstuvwxyz123456";
        vm.prank(router);
        registry.reserve(atLimit, "TICK", token, launcher);
    }

    function test_Reserve_RevertsOnTickerTooShort() public {
        vm.expectRevert(abi.encodeWithSelector(NameRegistry.NameRegistry__TickerLength.selector, uint256(1)));
        vm.prank(router);
        registry.reserve("Name", "T", token, launcher);
    }

    function test_Reserve_RevertsOnTickerTooLong() public {
        // 11 chars.
        vm.expectRevert(abi.encodeWithSelector(NameRegistry.NameRegistry__TickerLength.selector, uint256(11)));
        vm.prank(router);
        registry.reserve("Name", "TOOLONGTICK", token, launcher);
    }

    function test_Reserve_RevertsOnLowercaseTicker() public {
        vm.expectRevert(NameRegistry.NameRegistry__InvalidTickerChar.selector);
        vm.prank(router);
        registry.reserve("Name", "vmt", token, launcher);
    }

    function test_Reserve_RevertsOnTickerWithSpace() public {
        vm.expectRevert(NameRegistry.NameRegistry__InvalidTickerChar.selector);
        vm.prank(router);
        registry.reserve("Name", "VM T", token, launcher);
    }

    // =========================================================
    // Normalization equivalence
    // =========================================================

    function test_Reserve_CaseFoldCollision() public {
        vm.prank(router);
        registry.reserve("Foo", "FOO1", token, launcher);

        bytes32 nameHash = keccak256(bytes("foo"));
        vm.expectRevert(abi.encodeWithSelector(NameRegistry.NameRegistry__NameTaken.selector, nameHash));
        vm.prank(router);
        registry.reserve("foo", "FOO2", makeAddr("token2"), launcher);

        vm.expectRevert(abi.encodeWithSelector(NameRegistry.NameRegistry__NameTaken.selector, nameHash));
        vm.prank(router);
        registry.reserve("FOO", "FOO3", makeAddr("token3"), launcher);
    }

    function test_Reserve_WhitespaceCollapseCollision() public {
        vm.prank(router);
        registry.reserve("Foo Bar", "FBAR1", token, launcher);

        bytes32 nameHash = keccak256(bytes("foo bar"));
        vm.expectRevert(abi.encodeWithSelector(NameRegistry.NameRegistry__NameTaken.selector, nameHash));
        vm.prank(router);
        registry.reserve("  Foo   Bar  ", "FBAR2", makeAddr("token2"), launcher);
    }

    function test_Reserve_HyphenIsDistinctFromSpace() public {
        vm.prank(router);
        registry.reserve("Coca Cola", "COKE1", token, launcher);

        // "Coca-Cola" and "Coca Cola" MUST be distinct — hyphen is a distinct character by SPEC.
        vm.prank(router);
        registry.reserve("Coca-Cola", "COKE2", makeAddr("token2"), launcher);
    }

    function test_Reserve_ZeroAndOhAreDistinct() public {
        vm.prank(router);
        registry.reserve("F00", "F001", token, launcher);

        // "F00" (with zeros) and "FOO" (with letters) MUST be distinct.
        vm.prank(router);
        registry.reserve("FOO", "F002", makeAddr("token2"), launcher);
    }

    // =========================================================
    // Availability views
    // =========================================================

    function test_IsNameAvailable_FreshTrue() public view {
        assertTrue(registry.isNameAvailable("Never Reserved"));
    }

    function test_IsNameAvailable_TakenFalse() public {
        vm.prank(router);
        registry.reserve("Taken", "TKN", token, launcher);
        assertFalse(registry.isNameAvailable("Taken"));
        assertFalse(registry.isNameAvailable("TAKEN")); // case-insensitive
        assertFalse(registry.isNameAvailable("  taken  ")); // whitespace-insensitive
    }

    function test_IsNameAvailable_InvalidReturnsFalse() public view {
        assertFalse(registry.isNameAvailable(unicode"Cöla"));
        assertFalse(registry.isNameAvailable(""));
        assertFalse(registry.isNameAvailable("abcdefghijklmnopqrstuvwxyz1234567")); // >32
    }

    function test_IsTickerAvailable_FreshTrue() public view {
        assertTrue(registry.isTickerAvailable("FRESH"));
    }

    function test_IsTickerAvailable_ReservedFalse() public view {
        assertFalse(registry.isTickerAvailable("ETH"));
        assertFalse(registry.isTickerAvailable("USDC"));
    }

    function test_IsTickerAvailable_TakenFalse() public {
        vm.prank(router);
        registry.reserve("Some Name", "SOME", token, launcher);
        assertFalse(registry.isTickerAvailable("SOME"));
    }

    function test_IsTickerAvailable_InvalidReturnsFalse() public view {
        assertFalse(registry.isTickerAvailable("bad")); // lowercase
        assertFalse(registry.isTickerAvailable("T")); // too short
        assertFalse(registry.isTickerAvailable("TOOLONGTICKER")); // too long
    }

    // =========================================================
    // validateName / validateTicker — reason codes
    // =========================================================

    function test_ValidateName_Ok() public view {
        (bool valid, NameRegistry.ValidationReason reason) = registry.validateName("Fresh Name");
        assertTrue(valid);
        assertEq(uint256(reason), uint256(NameRegistry.ValidationReason.Ok));
    }

    function test_ValidateName_TooShort() public view {
        (bool valid, NameRegistry.ValidationReason reason) = registry.validateName("");
        assertFalse(valid);
        assertEq(uint256(reason), uint256(NameRegistry.ValidationReason.TooShort));
    }

    function test_ValidateName_TooLong() public view {
        (bool valid, NameRegistry.ValidationReason reason) = registry.validateName("abcdefghijklmnopqrstuvwxyz1234567");
        assertFalse(valid);
        assertEq(uint256(reason), uint256(NameRegistry.ValidationReason.TooLong));
    }

    function test_ValidateName_InvalidCharacter() public view {
        (bool valid, NameRegistry.ValidationReason reason) = registry.validateName(unicode"Cöla");
        assertFalse(valid);
        assertEq(uint256(reason), uint256(NameRegistry.ValidationReason.InvalidCharacter));
    }

    function test_ValidateName_AlreadyTaken() public {
        vm.prank(router);
        registry.reserve("Locked Name", "LKD", token, launcher);
        (bool valid, NameRegistry.ValidationReason reason) = registry.validateName("Locked Name");
        assertFalse(valid);
        assertEq(uint256(reason), uint256(NameRegistry.ValidationReason.AlreadyTaken));
    }

    function test_ValidateTicker_Reserved() public view {
        (bool valid, NameRegistry.ValidationReason reason) = registry.validateTicker("PEPE");
        assertFalse(valid);
        assertEq(uint256(reason), uint256(NameRegistry.ValidationReason.Reserved));
    }

    function test_ValidateTicker_TooShort() public view {
        (bool valid, NameRegistry.ValidationReason reason) = registry.validateTicker("A");
        assertFalse(valid);
        assertEq(uint256(reason), uint256(NameRegistry.ValidationReason.TooShort));
    }

    function test_ValidateTicker_TooLong() public view {
        (bool valid, NameRegistry.ValidationReason reason) = registry.validateTicker("ELEVENCHARS");
        assertFalse(valid);
        assertEq(uint256(reason), uint256(NameRegistry.ValidationReason.TooLong));
    }

    function test_ValidateTicker_InvalidCharacter() public view {
        (bool valid, NameRegistry.ValidationReason reason) = registry.validateTicker("lower");
        assertFalse(valid);
        assertEq(uint256(reason), uint256(NameRegistry.ValidationReason.InvalidCharacter));
    }

    function test_ValidateTicker_AlreadyTaken() public {
        vm.prank(router);
        registry.reserve("A Name", "TAKN", token, launcher);
        (bool valid, NameRegistry.ValidationReason reason) = registry.validateTicker("TAKN");
        assertFalse(valid);
        assertEq(uint256(reason), uint256(NameRegistry.ValidationReason.AlreadyTaken));
    }

    // =========================================================
    // Admin — setRouter, setTreasury, addReservedTicker, removeReservedTicker
    // =========================================================

    function test_SetRouter_OnlyOwner() public {
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        registry.setRouter(makeAddr("newRouter"));
    }

    function test_SetRouter_EmitsAndUpdates() public {
        address newRouter = makeAddr("newRouter");
        vm.expectEmit(true, true, false, true, address(registry));
        emit NameRegistry.RouterSet(router, newRouter);
        vm.prank(owner);
        registry.setRouter(newRouter);
        assertEq(registry.router(), newRouter);
    }

    function test_SetTreasury_OnlyOwner() public {
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        registry.setTreasury(makeAddr("newTreasury"));
    }

    function test_SetTreasury_EmitsAndUpdates() public {
        address newTreasury = makeAddr("newTreasury");
        vm.expectEmit(true, true, false, true, address(registry));
        emit NameRegistry.TreasurySet(treasury, newTreasury);
        vm.prank(owner);
        registry.setTreasury(newTreasury);
        assertEq(registry.treasury(), newTreasury);
    }

    function test_AddReservedTicker_OnlyOwner() public {
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        registry.addReservedTicker("NEW");
    }

    function test_AddReservedTicker_Success() public {
        vm.prank(owner);
        registry.addReservedTicker("NEW");
        assertFalse(registry.isTickerAvailable("NEW"));
        (, NameRegistry.ValidationReason reason) = registry.validateTicker("NEW");
        assertEq(uint256(reason), uint256(NameRegistry.ValidationReason.Reserved));
    }

    function test_AddReservedTicker_RevertsIfAlreadyClaimed() public {
        vm.prank(router);
        registry.reserve("Claimed", "CLM", token, launcher);

        bytes32 tickerHash = keccak256(bytes("CLM"));
        vm.expectRevert(
            abi.encodeWithSelector(NameRegistry.NameRegistry__CannotReserveClaimedTicker.selector, tickerHash)
        );
        vm.prank(owner);
        registry.addReservedTicker("CLM");
    }

    function test_RemoveReservedTicker_UnclaimedSuccess() public {
        vm.prank(owner);
        registry.removeReservedTicker("ETH");
        assertTrue(registry.isTickerAvailable("ETH"));

        // And now it's claimable.
        vm.prank(router);
        registry.reserve("Ether Alt", "ETH", token, launcher);
    }

    function test_RemoveReservedTicker_OnlyOwner() public {
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        registry.removeReservedTicker("ETH");
    }

    function test_RemoveReservedTicker_RevertsIfClaimed() public {
        // Force an inconsistent state — add a ticker to the reserved list, but first bypass the
        // "unclaimed" check inside `addReservedTicker` by writing to storage directly via a mock scenario.
        // Since we can't easily construct that state (the add-path prevents it), we instead verify
        // the removal path's defense-in-depth by claiming a NEW ticker and then trying to remove it
        // from the (empty) reserved list — expect no-op success rather than a revert here.
        //
        // The intended failure case (adding to reserved despite being claimed) is prevented by the
        // add-path invariant test above. This test documents the removal path's guard remains in place.
        vm.prank(owner);
        registry.removeReservedTicker("USDC"); // remove first
        vm.prank(router);
        registry.reserve("Circle Alt", "USDC", token, launcher); // claim it

        // Trying to remove USDC AGAIN — it's not in the reserved list anymore (we just removed it),
        // and it IS claimed. Normalization succeeds, hash is claimed, guard fires.
        bytes32 tickerHash = keccak256(bytes("USDC"));
        vm.expectRevert(
            abi.encodeWithSelector(NameRegistry.NameRegistry__CannotRemoveClaimedTicker.selector, tickerHash)
        );
        vm.prank(owner);
        registry.removeReservedTicker("USDC");
    }

    // =========================================================
    // Initial state / constructor
    // =========================================================

    function test_Constructor_SeedsReservedTickers() public view {
        assertFalse(registry.isTickerAvailable("ETH"));
        assertFalse(registry.isTickerAvailable("USDC"));
        assertFalse(registry.isTickerAvailable("WBTC"));
        assertFalse(registry.isTickerAvailable("PEPE"));
    }

    function test_Constructor_SetsOwnerAndTreasury() public view {
        assertEq(registry.owner(), owner);
        assertEq(registry.treasury(), treasury);
    }

    function test_Constructor_RouterUnsetUntilAdmin() public {
        string[] memory reserved = new string[](0);
        NameRegistry fresh = new NameRegistry(owner, treasury, reserved);
        assertEq(fresh.router(), address(0));
    }

    function test_Constructor_ValidatesReservedTickers() public {
        string[] memory bad = new string[](1);
        bad[0] = "lower"; // invalid at construction time
        vm.expectRevert(NameRegistry.NameRegistry__InvalidTickerChar.selector);
        new NameRegistry(owner, treasury, bad);
    }

    // =========================================================
    // isTickerReserved
    // =========================================================

    function test_IsTickerReserved_True() public view {
        assertTrue(registry.isTickerReserved(keccak256(bytes("ETH"))));
    }

    function test_IsTickerReserved_FalseAfterRemoval() public {
        vm.prank(owner);
        registry.removeReservedTicker("ETH");
        assertFalse(registry.isTickerReserved(keccak256(bytes("ETH"))));
    }

    // =========================================================
    // Fuzz — normalization invariance
    // =========================================================

    /// @dev Fuzz over a short alphanumeric string; any valid input should be reservable
    ///      the first time and taken the second.
    function testFuzz_Reserve_UniquenessOverValidInputs(
        bytes8 rawSeed
    ) public {
        // Build a printable 4-char name from the seed (ASCII letters only for guaranteed validity).
        bytes memory letters = "abcdefghijklmnopqrstuvwxyz";
        bytes memory name = new bytes(4);
        for (uint256 i; i < 4; ++i) {
            name[i] = letters[uint8(rawSeed[i]) % 26];
        }
        // Ticker: 3 uppercase letters derived from the seed offset.
        bytes memory upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        bytes memory ticker = new bytes(3);
        for (uint256 i; i < 3; ++i) {
            ticker[i] = upper[uint8(rawSeed[i + 4]) % 26];
        }

        // Skip reserved seed collisions.
        bytes32 tickerHash = keccak256(ticker);
        if (registry.isTickerReserved(tickerHash)) return;

        vm.prank(router);
        registry.reserve(string(name), string(ticker), token, launcher);

        // Second attempt with same name reverts (case-insensitive, so mixed case also collides).
        bytes32 nameHash = keccak256(bytes(_toLower(string(name))));
        vm.expectRevert(abi.encodeWithSelector(NameRegistry.NameRegistry__NameTaken.selector, nameHash));
        vm.prank(router);
        registry.reserve(string(name), "XYZ", makeAddr("token2"), launcher);
    }

    function _toLower(
        string memory s
    ) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(b.length);
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c >= 0x41 && c <= 0x5A) out[i] = bytes1(uint8(c) + 32);
            else out[i] = c;
        }
        return string(out);
    }
}
