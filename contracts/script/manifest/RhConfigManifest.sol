// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title  RhConfigManifest
/// @notice Canonical enumeration of every configHash the launchpad supports
///         on Robinhood, with its corresponding Router metadata (module count
///         + FLAG_BALANCE_MUTATING bit). Single source of truth consumed by
///         deploy scripts (to seed Router at deploy time), by verification
///         scripts (to assert live-Router state), and by the live-stack
///         snapshot test (to fail loud on drift).
///
///         WHY THIS EXISTS
///           Router fails closed on any hash whose `moduleCountConfigured` or
///           `flagsConfigured` is false. An August 2026 audit flagged that
///           DeployRouter was deploying Router without seeding these, so
///           any launch would revert until the operator manually ran twelve
///           setter txs. The green test suite hid this because integration
///           tests seeded the sentinels in setUp. Extracting the manifest
///           makes seeding a required, verifiable step of any Router deploy.
///
///         WHEN TO UPDATE
///           When a new module or module-combo is registered via
///           `ERC20Factory.registerImpl`. Add its (hash, moduleCount, flags)
///           entry here in one PR; every deploy script + snapshot test picks
///           it up automatically. Reverting a module = removing its entry.
///
///         SOURCING NEW ENTRIES
///           Each entry's fields:
///             configHash:  keccak256(abi.encode(baseName, sortedModuleIdsCsv))
///                          — same derivation the compile-service uses.
///             moduleCount: number of module fragments composed into the impl.
///             flags:       bitmap. Currently only FLAG_BALANCE_MUTATING (0x1)
///                          for tokens whose balances mutate outside of
///                          standard ERC20 transfers (FoT, rebase). Setting
///                          this correctly matters — the bit blocks curve
///                          launches for that hash (`isBalanceMutating` gate).
library RhConfigManifest {
    /// FLAG_BALANCE_MUTATING — matches Router's FLAG_BALANCE_MUTATING = 1<<0.
    /// Kept as a named constant here so future flags can be added by number
    /// without every consumer having to remember the bit layout.
    uint256 internal constant FLAG_BALANCE_MUTATING = 1;

    struct Entry {
        bytes32 configHash;
        uint256 moduleCount;
        uint256 flags;
        string label; // human-readable label for logs + revert strings
    }

    /// Every canonical configHash the fresh-stack deploy should seed on the
    /// Router and register an impl for on the ERC20Factory. Identified by
    /// reverse-engineering the V1 configHash formula
    /// `keccak256(abi.encode("ERC20", sortedModuleIds.join(",")))` against the
    /// 12 hashes that were live-registered pre-audit; see the section-header
    /// notes below for the two intentional exclusions.
    ///
    /// KEEP THIS IN SYNC with `web/src/lib/modules.ts:configHashFor`. When a
    /// new module or combo ships in the compile-service matrix + registers on
    /// the ERC20Factory, add its entry here in the SAME PR.
    ///
    /// INTENTIONALLY EXCLUDED (do NOT re-add without owner sign-off — these
    /// have a documented security concern):
    ///   • `keccak256(abi.encode("ERC20", "Airdrop"))`         — 0x344f85…7b2b
    ///   • `keccak256(abi.encode("ERC20", "Airdrop,Permit"))`  — 0xa4df91…2064
    ///   • `keccak256(abi.encode("ERC20", "Airdrop,Vesting"))` — 0x903cca…f3d2
    /// All three are Airdrop combos. The Airdrop V1 composed impls were
    /// retired (`project_airdrop_retired_2026_07_30.md`) because the deployed
    /// impls contain an inflation-rug bug. `ERC20Factory.registerImpl` is
    /// one-shot, so these three hashes remain pointed at the rugged impls on
    /// the LIVE factory today. A hand-crafted launch tx (bypassing the
    /// frontend, which no longer produces these hashes) could still resolve
    /// to the rugged impl.
    ///
    /// LIVE MITIGATION: all three hashes are exposed via
    /// `retiredAirdropHashes()` below and MUST be passed to
    /// `Router.setConfigHashBanned(hash, true)` at every Router deploy /
    /// rotation. DeployRouter + DeployFreshLocal + ActivateRouter all read
    /// from that list and the deploy scripts refuse to write an address book
    /// unless every entry is confirmed banned on the new Router. See PR #1
    /// audit round 2 v5 for the auditor's rationale.
    ///
    /// When Airdrop V2 ships, register at a NEW configHash (tagged with the
    /// version suffix per `configHashFor` V2 branch); do not reuse the retired
    /// V1 hashes.
    uint256 internal constant COUNT = 10;
    uint256 internal constant RETIRED_COUNT = 3;

    /// Every configHash that must be BANNED on every Router deploy / rotation.
    /// Source of truth for `Router.setConfigHashBanned` calls in DeployRouter,
    /// DeployFreshLocal, ActivateRouter (post-cutover verify), and the
    /// production-rotation fork test. Do NOT hand-maintain this list anywhere
    /// else — every consumer must read from here.
    function retiredAirdropHashes() internal pure returns (bytes32[] memory hashes) {
        hashes = new bytes32[](RETIRED_COUNT);
        // Standalone Airdrop (1 module, V1 formula).
        hashes[0] = 0x344f851ff67d34148ac2000b192fbc9a5cc4edd0ef612cd60c3e9d90738e7b2b;
        // Airdrop+Permit (V1 formula, sorted alphabetically: "Airdrop,Permit").
        hashes[1] = 0xa4df91ce9ab236d5e29251310259042c2d769b0e1ac21d4153ffa391ef492064;
        // Airdrop+Vesting (V1 formula, sorted: "Airdrop,Vesting").
        hashes[2] = 0x903cca7212ee848c97d09fd3417f909ddbf131965f0b66e4d995d6eb7b49f3d2;
    }

    /// Human-readable label for each retired hash — used in log lines +
    /// revert reasons only, not consumed by contract logic. Order MUST match
    /// `retiredAirdropHashes()`.
    function retiredAirdropLabels() internal pure returns (string[] memory labels) {
        labels = new string[](RETIRED_COUNT);
        labels[0] = "Airdrop";
        labels[1] = "Airdrop+Permit";
        labels[2] = "Airdrop+Vesting";
    }

    /// Return the full manifest as a memory array. Order is stable — do not
    /// re-sort. If order ever changes, snapshot tests that pin by index will
    /// need corresponding updates.
    function all() internal pure returns (Entry[] memory entries) {
        entries = new Entry[](COUNT);
        entries[0] = Entry({
            configHash: 0xaa7c4a90c46fc33ebca677ac422fef548b4af9424a17314603d05496a4b07d7e,
            moduleCount: 1,
            flags: 0,
            label: "Permit"
        });
        entries[1] = Entry({
            configHash: 0xafdb27f10a1e64171b7bb7ee9dbf1f5d8c238312ff2a3457d76e37193c63f4a8,
            moduleCount: 1,
            flags: 0,
            label: "Vesting"
        });
        entries[2] = Entry({
            configHash: 0x3c31bf2240ae0f6a7f4ad9554da97d554e83e0ae6d417eadb7201502b26d2836,
            moduleCount: 1,
            flags: 0,
            label: "Staking"
        });
        entries[3] = Entry({
            configHash: 0x665f84252f363c24ab35bdb96469a73ca840a1c47c1bd3acddf8e72953d01b10,
            moduleCount: 1,
            flags: 0,
            label: "Votes"
        });
        entries[4] = Entry({
            configHash: 0xf7b8c67f3c497ace04f267a7b77845c97e685bd8ba1b0bec3d54a28e64a30acb,
            moduleCount: 0,
            flags: 0,
            label: "bare"
        });
        entries[5] = Entry({
            configHash: 0x1369b5e16db64b51494968e9da45d2567436fa8815f21d3dd69a3f8947f4973f,
            moduleCount: 1,
            flags: 0,
            label: "AntiBot"
        });
        entries[6] = Entry({
            configHash: 0x638593049fc24c8e112d3d12c307afdc8ae86f6968c7fd3baf7d6c5662b53821,
            moduleCount: 1,
            flags: 0,
            label: "AntiWhale"
        });
        entries[7] = Entry({
            configHash: 0xa73336ef5d2b7ad3439ea3df1f32c5a34fe653411d944d8d0b005b1cd34e1ac4,
            moduleCount: 1,
            flags: FLAG_BALANCE_MUTATING,
            label: "FoT"
        });
        entries[8] = Entry({
            configHash: 0xa831bae1a66d3623be52065f464133bc90bd2eff45d4dc07d911b639ccdc803a,
            moduleCount: 1,
            flags: 0,
            label: "Pausable"
        });
        // Permit+Staking (V1 formula, 2 modules). Identified by hash-matching
        // 0x12073e…575e against `keccak256(abi.encode("ERC20", "Permit,Staking"))`
        // during the August 2026 audit round; impl on-chain is
        // 0x8f49A3186E11F86cC61a94df52B252EF0945Fb05.
        entries[9] = Entry({
            configHash: 0x12073e30535ae2e9ccc627d8cc51449949ad96e7846c55f8e39bec895382575e,
            moduleCount: 2,
            flags: 0,
            label: "Permit+Staking"
        });
    }

    /// Return the (hashes, counts) parallel arrays shaped for direct use with
    /// `Router.setModuleCountForConfigBatch(bytes32[], uint256[])`.
    function hashesAndCounts() internal pure returns (bytes32[] memory hashes, uint256[] memory counts) {
        Entry[] memory entries = all();
        hashes = new bytes32[](entries.length);
        counts = new uint256[](entries.length);
        for (uint256 i = 0; i < entries.length; i++) {
            hashes[i] = entries[i].configHash;
            counts[i] = entries[i].moduleCount;
        }
    }

    /// Return the (hashes, flags) parallel arrays shaped for direct use with
    /// `Router.setFlagsForConfigBatch(bytes32[], uint256[])`.
    function hashesAndFlags() internal pure returns (bytes32[] memory hashes, uint256[] memory flags) {
        Entry[] memory entries = all();
        hashes = new bytes32[](entries.length);
        flags = new uint256[](entries.length);
        for (uint256 i = 0; i < entries.length; i++) {
            hashes[i] = entries[i].configHash;
            flags[i] = entries[i].flags;
        }
    }
}
