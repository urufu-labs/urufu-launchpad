// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title  HookMiner
/// @notice CREATE2 salt search for Uniswap v4 hook deployment. v4 encodes hook permissions
///         in the low 14 bits of the hook address, so `new HookContract()` alone will not
///         produce a deployable hook — the address's low bits must equal the required
///         permission mask.
/// @dev    Off-chain tooling can call `find` in a forge script to compute a salt, then pass
///         `salt` to a CREATE2 deployer. Loop is bounded to prevent runaway gas usage in
///         tests; production searches should run off-chain.
library HookMiner {
    /// @dev A hook address is valid if `address & FLAG_MASK == requiredFlags`.
    uint160 internal constant FLAG_MASK = 0x3FFF; // low 14 bits

    error HookMiner__ExhaustedSearch(uint256 tried);

    /// @notice Find a CREATE2 salt such that the resulting address's low 14 bits match
    ///         `requiredFlags`. Returns the salt and the predicted hook address.
    /// @param  deployer         Address that will run the CREATE2 op.
    /// @param  requiredFlags    Permission bitset, e.g. `1 << 9` for BEFORE_REMOVE_LIQUIDITY.
    /// @param  creationCode     `type(HookContract).creationCode`.
    /// @param  constructorArgs  ABI-encoded constructor args, or `""` for no args.
    /// @param  maxIterations    Upper bound on the search loop.
    function find(
        address deployer,
        uint160 requiredFlags,
        bytes memory creationCode,
        bytes memory constructorArgs,
        uint256 maxIterations
    ) internal pure returns (uint256 salt, address hookAddress) {
        bytes32 initCodeHash = keccak256(abi.encodePacked(creationCode, constructorArgs));
        for (salt = 0; salt < maxIterations; ++salt) {
            hookAddress = _computeAddress(deployer, salt, initCodeHash);
            if ((uint160(hookAddress) & FLAG_MASK) == (requiredFlags & FLAG_MASK)) {
                return (salt, hookAddress);
            }
        }
        revert HookMiner__ExhaustedSearch(maxIterations);
    }

    function _computeAddress(
        address deployer,
        uint256 salt,
        bytes32 initCodeHash
    ) private pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}
