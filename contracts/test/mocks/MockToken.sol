// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal `IOwnable`-compatible token stand-in used by Router tests.
/// @dev    Real tokens will use Solady `Ownable` inside their base templates. This stand-in
///         only exists so Router unit tests can exercise ownership dispatch without pulling
///         in the whole template infrastructure.
contract MockToken {
    address public owner;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    error NotOwner();

    constructor(
        address _owner
    ) {
        owner = _owner;
    }

    function transferOwnership(
        address newOwner
    ) external {
        if (msg.sender != owner) revert NotOwner();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function renounceOwnership() external {
        if (msg.sender != owner) revert NotOwner();
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
    }
}
