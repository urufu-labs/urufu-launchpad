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
    /// FLAG_REQUIRES_OWNER — matches Router.FLAG_REQUIRES_OWNER = 1<<1.
    /// Set on any impl whose module set exposes post-launch owner powers
    /// (Pausable, AntiBot, AntiWhale). URU-A01: Router rejects such configs
    /// paired with `installBondingCurve = true` because a curve launch is
    /// meant to be ownerless (renounces at Router-side dispatch).
    uint256 internal constant FLAG_REQUIRES_OWNER = 1 << 1;

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
    ///   • `keccak256(abi.encode("ERC20", "Pausable"))`        — 0xa831ba…803a
    /// The first three are Airdrop combos. The Airdrop V1 composed impls were
    /// retired (`project_airdrop_retired_2026_07_30.md`) because the deployed
    /// impls contain an inflation-rug bug.
    ///
    /// The fourth is Pausable V1. Per URU-A02, the V1 fragment exempted
    /// `from == owner()` transfers while paused — a one-sided sell freeze that
    /// let the owner dump while holders were trapped. Pausable V2 removes that
    /// exemption; V2 lands at a new configHash `0xc9a87c…3e1f` (module string
    /// is Pausable version 2 per the versioned canonical form). The V1 hash
    /// stays permanently banned.
    ///
    /// `ERC20Factory.registerImpl` is one-shot, so these hashes remain
    /// pointed at the compromised impls on the LIVE factory today. A hand-
    /// crafted launch tx (bypassing the frontend, which no longer produces
    /// these hashes) could still resolve to the compromised impl.
    ///
    /// LIVE MITIGATION: every retired hash is exposed via
    /// `retiredAirdropHashes()` (name kept for backwards-compat with existing
    /// callers) and MUST be passed to `Router.setConfigHashBanned(hash, true)`
    /// at every Router deploy / rotation. DeployRouter + DeployFreshLocal
    /// read from that list and the deploy scripts refuse to write an address
    /// book unless every entry is confirmed banned on the new Router.
    ///
    /// When Airdrop V2 ships, register at a NEW configHash (tagged with the
    /// version suffix per `configHashFor` V2 branch); do not reuse the retired
    /// V1 hashes.
    uint256 internal constant COUNT = 20;
    uint256 internal constant RETIRED_COUNT = 4;

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
        // Pausable V1 — allowed owner-originated transfers while holders were
        // frozen (URU-A02). V2 lands at 0xc9a87c…3e1f.
        hashes[3] = 0xa831bae1a66d3623be52065f464133bc90bd2eff45d4dc07d911b639ccdc803a;
    }

    /// Human-readable label for each retired hash — used in log lines +
    /// revert reasons only, not consumed by contract logic. Order MUST match
    /// `retiredAirdropHashes()`.
    function retiredAirdropLabels() internal pure returns (string[] memory labels) {
        labels = new string[](RETIRED_COUNT);
        labels[0] = "Airdrop";
        labels[1] = "Airdrop+Permit";
        labels[2] = "Airdrop+Vesting";
        labels[3] = "Pausable@1";
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
        // URU-A01: AntiBot exposes `setAntiBotAllowed` as owner-only. Curve launches
        // must renounce and cannot pair with this without giving the launcher an
        // ongoing censorship lever. Router._validateLaunchPolicy rejects the combo.
        entries[5] = Entry({
            configHash: 0x1369b5e16db64b51494968e9da45d2567436fa8815f21d3dd69a3f8947f4973f,
            moduleCount: 1,
            flags: FLAG_REQUIRES_OWNER,
            label: "AntiBot"
        });
        // URU-A01: AntiWhale exposes `setAntiWhaleExcluded` as owner-only. Same reason.
        entries[6] = Entry({
            configHash: 0x638593049fc24c8e112d3d12c307afdc8ae86f6968c7fd3baf7d6c5662b53821,
            moduleCount: 1,
            flags: FLAG_REQUIRES_OWNER,
            label: "AntiWhale"
        });
        entries[7] = Entry({
            configHash: 0xa73336ef5d2b7ad3439ea3df1f32c5a34fe653411d944d8d0b005b1cd34e1ac4,
            moduleCount: 1,
            flags: FLAG_BALANCE_MUTATING,
            label: "FoT"
        });
        // Pausable V2 — post-URU-A02, the fragment no longer exempts owner-origin
        // transfers. Version bump to @2 forces a new configHash so V1 clones on
        // the live factory stay pinned to their (retired) bytecode. V1 hash
        // `0xa831ba…803a` is in `retiredAirdropHashes()` and permanently banned.
        // FLAG_REQUIRES_OWNER prevents pairing with the bonding curve.
        entries[8] = Entry({
            configHash: 0xc9a87cbca9b96a91b5d8f29c4cacc6748e305cae57916c56e73ddafedb143e1f,
            moduleCount: 1,
            flags: FLAG_REQUIRES_OWNER,
            label: "Pausable@2"
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

        // -----------------------------------------------------------------
        // Round-6 audit coverage: the 10 valid 2-module composed templates
        // the compile-service can splice on-demand from the token/allocation
        // modules { AntiBot, AntiWhale, Permit, Votes, Staking, Vesting }.
        // Alphabetical sort of module ids -> csv -> hash (V1 formula, matches
        // web/src/lib/modules.ts:configHashFor).
        //
        // Staking + Vesting is intentionally omitted: matrix.json declares
        // Staking.incompatibleWith = ["FeeOnTransfer", "Vesting"] so
        // validateConfig rejects the compose in the compile-service. Never
        // reaches users; no manifest entry needed.
        //
        // FLAG_REQUIRES_OWNER carries the URU-A01 gate: any config exposing
        // an owner-only post-launch setter (AntiBot's setAntiBotAllowed,
        // AntiWhale's setAntiWhaleExcluded) is rejected as a curve pair by
        // Router._validateLaunchPolicy. Direct launches (installBondingCurve
        // = false) still work; only the curve-and-graduate flow is blocked
        // for the launcher's own censorship-lever protection.
        // -----------------------------------------------------------------
        entries[10] = Entry({
            configHash: 0x779e0a134de790a01351aa2994122107925563df8cb3154654c07dd124439fbe,
            moduleCount: 2,
            flags: FLAG_REQUIRES_OWNER,
            label: "AntiBot+Staking"
        });
        entries[11] = Entry({
            configHash: 0x8e63f0828205bf8bd2aecdaa7ee6e3876cd7426be3a80e83c1817a03ac4b5e6c,
            moduleCount: 2,
            flags: FLAG_REQUIRES_OWNER,
            label: "AntiBot+Vesting"
        });
        entries[12] = Entry({
            configHash: 0xca3f275973524fe09fe4f21db01550a38089589b662cd97659cd3ebce2363707,
            moduleCount: 2,
            flags: FLAG_REQUIRES_OWNER,
            label: "AntiBot+Votes"
        });
        entries[13] = Entry({
            configHash: 0xb972cf598b9a40841c562e5db354dffad58376610e9a6ccb22a173573a010c0d,
            moduleCount: 2,
            flags: FLAG_REQUIRES_OWNER,
            label: "AntiWhale+Permit"
        });
        entries[14] = Entry({
            configHash: 0xb2344b3135a2516ab2b2871ee007f3fc34bcff060b98d488ae3a5e8bfe68c7ba,
            moduleCount: 2,
            flags: FLAG_REQUIRES_OWNER,
            label: "AntiWhale+Staking"
        });
        entries[15] = Entry({
            configHash: 0xb09a3a1c183d279dd7ab8316681afd97f6d1df777c168b77e2a829948a055487,
            moduleCount: 2,
            flags: FLAG_REQUIRES_OWNER,
            label: "AntiWhale+Vesting"
        });
        entries[16] = Entry({
            configHash: 0x258c2a36d154023edfdb4394159e5fc7aac98f82970261b9b1572648471982cc,
            moduleCount: 2,
            flags: FLAG_REQUIRES_OWNER,
            label: "AntiWhale+Votes"
        });
        entries[17] = Entry({
            configHash: 0xacb5f4d792116138707209dc606c347b789a07b3d8d7adbadd3a8268dcce8787,
            moduleCount: 2,
            flags: 0,
            label: "Permit+Votes"
        });
        entries[18] = Entry({
            configHash: 0xf08606a43a6697520afe74b387cdeb19d854c09cb6d572a4a835880dc7df4ab0,
            moduleCount: 2,
            flags: 0,
            label: "Staking+Votes"
        });
        entries[19] = Entry({
            configHash: 0x11a2de7b67a38f7790d845ee94eaafd875f1a04a2e2646178fe666649de268ab,
            moduleCount: 2,
            flags: 0,
            label: "Vesting+Votes"
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
