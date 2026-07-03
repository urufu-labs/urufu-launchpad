// SPDX-License-Identifier: MIT
// VM_MODULE_ID: Airdrop
// VM_MODULE_VERSION: 1
// VM_MODULE_BASES: ERC20
// VM_MODULE_REQUIRES:
// VM_MODULE_INCOMPATIBLE_WITH:
// VM_MODULE_FLAGGED:
//
// Merkle-tree airdrop. Owner (or the compile-service) builds a merkle root off-chain listing
// `(recipient, amount)` pairs. Root is stored at init. Any recipient calls `airdropClaim` with
// their amount + inclusion proof; the module verifies via Solady `MerkleProofLib` and `_mint`s
// the amount to the caller. Each address claims once.
//
// Leaf format: `keccak256(abi.encodePacked(recipient, amount))`. Amounts are wei (18 decimals).
//
// Note: airdrop tokens are minted at claim time — total supply grows as claims come in. Set the
// initial supply parameter to the launch treasury, not to the treasury + airdrop pool.
//
// Params: (bytes32 merkleRoot)

// ============================================================
// SECTION: VM_INJECT_ERRORS
// ============================================================
error Airdrop__AlreadyClaimed(address recipient);
error Airdrop__InvalidProof();

// ============================================================
// SECTION: VM_INJECT_EVENTS
// ============================================================
event AirdropConfigured(bytes32 merkleRoot);
event AirdropClaimed(address indexed recipient, uint256 amount);

// ============================================================
// SECTION: VM_INJECT_STATE
// ============================================================
bytes32 private _airdropRoot;
mapping(address => bool) private _airdropClaimed;

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
{
    bytes32 root = abi.decode(moduleData, (bytes32));
    _airdropRoot = root;
    emit AirdropConfigured(root);
}

// ============================================================
// SECTION: VM_INJECT_EXTERNAL
// ============================================================
function airdropClaim(uint256 amount, bytes32[] calldata proof) external {
    if (_airdropClaimed[msg.sender]) revert Airdrop__AlreadyClaimed(msg.sender);
    bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount));
    if (!MerkleProofLib.verifyCalldata(proof, _airdropRoot, leaf)) revert Airdrop__InvalidProof();
    _airdropClaimed[msg.sender] = true;
    _mint(msg.sender, amount);
    emit AirdropClaimed(msg.sender, amount);
}

function airdropRoot() external view returns (bytes32) {
    return _airdropRoot;
}

function airdropHasClaimed(address user) external view returns (bool) {
    return _airdropClaimed[user];
}
