// SPDX-License-Identifier: MIT
// VM_MODULE_ID: Airdrop
// VM_MODULE_VERSION: 2
// VM_MODULE_BASES: ERC20
// VM_MODULE_REQUIRES:
// VM_MODULE_INCOMPATIBLE_WITH:
// VM_MODULE_FLAGGED:
//
// Merkle-tree airdrop, reserve-backed. Launcher builds a merkle root off-chain listing
// `(recipient, amount)` pairs and passes both the root AND `totalAllocation` (the sum of
// every leaf's amount) at init. Root + total are stored on the token. Each recipient calls
// `airdropClaim(amount, proof)` — module verifies via Solady `MerkleProofLib`, tracks
// per-address claimed, and transfers the amount from the token's own reserve balance.
//
// Reserve-backed: at init the `totalAllocation` is transferred from `mintTarget` (Router
// when launching via Router) into `address(this)`. Claims move from that reserve to the
// caller — total supply NEVER grows post-launch. Init reverts (via _transfer's underflow
// revert) if the launcher tries to allocate more than mintTarget can spare, so the
// fixed-supply invariant is safe by construction. If the launcher misconfigures
// `totalAllocation < Σ merkle leaves`, later claims revert with insufficient reserve
// balance — legitimate loud fail.
//
// Leaf format: `keccak256(abi.encodePacked(recipient, amount))`. Amounts are wei (18 decimals).
//
// Params: (bytes32 merkleRoot, uint256 totalAllocation)

// ============================================================
// SECTION: VM_INJECT_ERRORS
// ============================================================
error Airdrop__AlreadyClaimed(address recipient);
error Airdrop__InvalidProof();
error Airdrop__ZeroAllocation();

// ============================================================
// SECTION: VM_INJECT_EVENTS
// ============================================================
event AirdropConfigured(bytes32 merkleRoot, uint256 totalAllocation);
event AirdropClaimed(address indexed recipient, uint256 amount);

// ============================================================
// SECTION: VM_INJECT_STATE
// ============================================================
bytes32 private _airdropRoot;
uint256 private _airdropTotalAllocation;
uint256 private _airdropClaimedTotal;
mapping(address => bool) private _airdropClaimed;

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
{
    (bytes32 root, uint256 totalAllocation_) = abi.decode(moduleData, (bytes32, uint256));
    if (totalAllocation_ == 0) revert Airdrop__ZeroAllocation();
    _airdropRoot = root;
    _airdropTotalAllocation = totalAllocation_;
    // Reserve the airdrop pool out of the initial supply. Reverts inside solady's
    // _transfer when mintTarget's balance underflows — safety by construction.
    _transfer(mintTarget, address(this), totalAllocation_);
    emit AirdropConfigured(root, totalAllocation_);
}

// ============================================================
// SECTION: VM_INJECT_EXTERNAL
// ============================================================
function airdropClaim(uint256 amount, bytes32[] calldata proof) external {
    if (_airdropClaimed[msg.sender]) revert Airdrop__AlreadyClaimed(msg.sender);
    bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount));
    if (!MerkleProofLib.verifyCalldata(proof, _airdropRoot, leaf)) revert Airdrop__InvalidProof();
    _airdropClaimed[msg.sender] = true;
    _airdropClaimedTotal += amount;
    // Reserve-backed: pay from the pre-allocated pool on address(this), NOT via _mint.
    // Total supply stays fixed. If the launcher misconfigured (merkle sum >
    // totalAllocation) claims eventually revert here when the reserve runs dry.
    _transfer(address(this), msg.sender, amount);
    emit AirdropClaimed(msg.sender, amount);
}

function airdropRoot() external view returns (bytes32) {
    return _airdropRoot;
}

function airdropTotalAllocation() external view returns (uint256) {
    return _airdropTotalAllocation;
}

function airdropClaimedTotal() external view returns (uint256) {
    return _airdropClaimedTotal;
}

function airdropHasClaimed(address user) external view returns (bool) {
    return _airdropClaimed[user];
}
