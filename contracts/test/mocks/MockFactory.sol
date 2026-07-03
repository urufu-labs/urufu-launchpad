// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IVMFactory} from "src/router/Router.sol";
import {MockToken} from "test/mocks/MockToken.sol";

/// @notice Mock `IVMFactory` for Router unit tests. Records the last call and returns a fresh
///         `MockToken` owned by Router (so Router can dispatch ownership after).
contract MockFactory is IVMFactory {
    address public router;
    uint256 public deployCount;

    // Last call.
    string public lastName;
    string public lastTicker;
    bytes32 public lastConfigHash;
    bytes public lastInitData;
    address public lastLauncher;

    // Test controls.
    address public nextDeployedToken; // if set, return this and clear
    bool public shouldRevert;
    bool public shouldReturnZero;

    error NotRouter();
    error Forced();

    function setRouter(
        address r
    ) external {
        router = r;
    }

    function setNextDeployedToken(
        address t
    ) external {
        nextDeployedToken = t;
    }

    function setShouldRevert(
        bool r
    ) external {
        shouldRevert = r;
    }

    function setShouldReturnZero(
        bool r
    ) external {
        shouldReturnZero = r;
    }

    function deploy(
        string calldata name,
        string calldata ticker,
        bytes32 configHash,
        bytes calldata initData,
        address launcher
    ) external returns (address token) {
        if (msg.sender != router) revert NotRouter();
        if (shouldRevert) revert Forced();

        lastName = name;
        lastTicker = ticker;
        lastConfigHash = configHash;
        lastInitData = initData;
        lastLauncher = launcher;
        unchecked {
            ++deployCount;
        }

        if (shouldReturnZero) return address(0);

        if (nextDeployedToken != address(0)) {
            token = nextDeployedToken;
            nextDeployedToken = address(0);
        } else {
            // Deploy a fresh MockToken with Router (msg.sender) as owner so ownership dispatch works.
            token = address(new MockToken(msg.sender));
        }
    }
}
