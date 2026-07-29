
export const meta = {
  name: 'v5-full-circle-audit',
  description: 'End-to-end V5 launchpad audit: on-chain wiring + fork tests + config alignment + repo-wide stale-address hunt',
  phases: [
    { title: 'Discover', detail: 'parallel scans of every layer' },
    { title: 'Fork-test', detail: 'run every test suite against live V5' },
    { title: 'Synthesize', detail: 'consolidated pass/fail report' },
  ],
}

const V5 = {
  Router:        '0x5EFA396B42210c16F2aaDE2dB1Fe7E88054c33DE',
  Graduator:     '0xaf62e66B6039cCd11a5953e3f3dB342CF7EAa489',
  MultiHookHost: '0xd19d999A3E35cA4b28f245D9bAf30FeFf4F862c4',
}
const OLD = {
  Router:        '0xb8512f2d1CA89e56CDbB2b7Ef3e94B38434a66a2',
  Graduator:     '0xbf3DAdD9EE1538F7cd7de012f71cf8626829939b',
  MultiHookHost: '0x3a3e0FB55e321e31B2C72973EF8Ad796186ba2C4',
}
const UNCHANGED = {
  CurveFactory:         '0x4631C21b066D3B289779e477fc79f13E8d0Fc248',
  BondingCurveImpl:     '0x5afcA487A9DB4728fb23B1b8A2f22931d49b5Aa9',
  FeeSplitter:          '0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA',
  NftRevenueVault:      '0x93CFF459d5019eEc82fE9335013e265F1eD659c7',
  UruBuybackVault:      '0x68c5Ec467027fCe56f158eB1ff34cF89d0929354',
  UruDepositSink:       '0xA6b3748023540af1aD4C4731E8B8A09fACFf737e',
  V4SwapRouter:         '0x2E4cd43C07879f52422B3e83F00Be877eFD88738',
  RoyaltyRouterFactory: '0x6309D5EcBbE9E2093D5b0f08AD86dDDa6988dB05',
  PoolManager:          '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  NameRegistry:         '0x60b797f18292d941E72B2b59916C0afC1A81118C',
  URU:                  '0x9fbe210007dDd8389f98d0253018e65CC48b9D24',
}

const REPO = 'C:\\Users\\brand\\OneDrive\\Desktop\\launchpad'
const CONTRACTS = REPO + '\\contracts'
const RPC = 'https://rpc.mainnet.chain.robinhood.com'

const context = `
Robinhood chain (id 4663). V5 mini-redeploy just landed. THREE contracts are new — everything else is unchanged.
NEW (V5):        ${JSON.stringify(V5, null, 2)}
OLD (paused/dead): ${JSON.stringify(OLD, null, 2)}
UNCHANGED:       ${JSON.stringify(UNCHANGED, null, 2)}
Repo:  ${REPO}
Contracts dir: ${CONTRACTS}
RPC: ${RPC}

Fixes shipped in V5:
1. Graduator: msg.sender == curveFactory.curveFor(token) access check (blocks pool-init front-run)
2. RouterV2: FoT-blacklist check on launchWithURU + launchWithWhitelist + launchWithURUAndWhitelist (was only on parent Router.launch)
3. Old Router (0xb851…) has paused=true. Old Router is untrusted by CurveFactory + RoyaltyRouterFactory.
`

const FINDING_SCHEMA = {
  type: 'object',
  required: ['dimension', 'status', 'findings'],
  properties: {
    dimension: { type: 'string' },
    status: { enum: ['pass', 'fail', 'inconclusive'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'title', 'detail'],
        properties: {
          severity: { enum: ['blocker', 'high', 'medium', 'low', 'info'] },
          title: { type: 'string' },
          detail: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
        },
      },
    },
    what_ran: { type: 'string', description: 'What tests/commands actually executed and their result' },
  },
}

phase('Discover')

const dimensions = [
  {
    key: 'onchain-wires',
    prompt: `${context}\n\nUsing cast + the RPC above, verify the ENTIRE V5 wiring on-chain. Check every reachable slot:\n- Router (${V5.Router}): owner, curveFactory, loyaltyOracle, uru, uruSink, minUruFee, paused, factories(0/1/2), curveIncompatibleConfigHash(0xa73336ef5d2b7ad3439ea3df1f32c5a34fe653411d944d8d0b005b1cd34e1ac4), registry, feeReceiver, fees(0/1/2)\n- Graduator (${V5.Graduator}): defaultHook, curveFactory, poolManager, fee, tickSpacing\n- MultiHookHost (${V5.MultiHookHost}): initializer, poolManager, creator, platformBps, creatorBps\n- CurveFactory (${UNCHANGED.CurveFactory}): graduator, trustedRouters[V5.Router]==true, trustedRouters[OLD.Router]==false\n- RoyaltyRouterFactory (${UNCHANGED.RoyaltyRouterFactory}): trustedDeployer[V5.Router]==true, trustedDeployer[OLD.Router]==false\n- NameRegistry (${UNCHANGED.NameRegistry}): router\n- OLD Router (${OLD.Router}): paused==true\n- OLD MultiHookHost + Graduator: still deployed but no longer referenced anywhere reachable through V5 path.\nFlag ANY value that doesn't match expected. Report as JSON per schema.`,
    label: 'audit:on-chain',
  },
  {
    key: 'frontend-config',
    prompt: `${context}\n\nAudit the frontend for stale addresses. Grep the entire ${REPO}\\web tree for each OLD address (${OLD.Router}, ${OLD.Graduator}, ${OLD.MultiHookHost}) and any reference to the string "V4" that's user-facing. For the robinhood block in web/src/lib/config.ts, verify all 3 V5 addresses are present and no OLD address remains. Also check web/src/lib/config.ts for the CONTRACTS block, GRADUATORS block, and any hook host maps. Any file the frontend consumes that still points at OLD should be flagged as fail. Read the files — don't guess. Report per schema with concrete file:line evidence.`,
    label: 'audit:frontend-config',
  },
  {
    key: 'indexer-config',
    prompt: `${context}\n\nAudit ${REPO}\\indexer for staleness. The indexer resolves addresses via readAddress(slug, key) which reads env vars. Verify:\n1. indexer/chains.ts still lists all the ADDRESS_KEYS Ponder needs.\n2. indexer/ponder.config.ts references those keys — grep for any hardcoded OLD address.\n3. The .env file (${REPO}\\.env, gitignored — read it, DON'T commit or echo private keys) has ROBINHOOD_ROUTER_ADDRESS = ${V5.Router}, ROBINHOOD_MULTI_HOOK_HOST_ADDRESS = ${V5.MultiHookHost}, PONDER_START_BLOCK_ROBINHOOD = 20403900.\n4. The event ABIs registered in ponder.config.ts cover the ones RouterV2, FeeSplitter, UruBuybackVault emit.\nReport per schema.`,
    label: 'audit:indexer-config',
  },
  {
    key: 'compile-service',
    prompt: `${context}\n\nAudit ${REPO}\\compile-service. Since URU rewards migrated to Robinhood only:\n1. Confirm rewards.ts only branches on 'robinhood' — no lingering 'base' cases.\n2. Confirm routes/rewards.ts z.enum only includes 'robinhood'.\n3. Confirm any RH env var references (ROBINHOOD_NFT_REVENUE_VAULT_ADDRESS, ROBINHOOD_GEMU_NFT_ADDRESS, ROBINHOOD_RPC_URL) match reality — .env values are: NFT vault ${UNCHANGED.NftRevenueVault}, gemu NFT 0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17.\n4. Confirm the wl-snapshot.ts helper still points at the right chain/factory.\nReport per schema with file:line evidence.`,
    label: 'audit:compile-service',
  },
  {
    key: 'repo-stale-addresses',
    prompt: `${context}\n\nHunt for stale references across the WHOLE ${REPO} repo (excluding node_modules, .next, out, cache, broadcast, .git). Grep for:\n- Old Router: ${OLD.Router}\n- Old Graduator: ${OLD.Graduator}\n- Old MultiHookHost: ${OLD.MultiHookHost}\n\nFor each match report file:line and classify:\n- ACCEPTABLE (historical: git commit messages, deployment book records, script variable names for what to REPLACE, comments describing the OLD contract)\n- STALE (config, code path, or docs that will actually run and hit the OLD address in production)\nReport per schema. Focus on STALE.`,
    label: 'audit:stale-addresses',
  },
]

const discoveries = await parallel(
  dimensions.map(d => () =>
    agent(d.prompt, { label: d.label, phase: 'Discover', schema: FINDING_SCHEMA, effort: 'medium' })
  )
)

phase('Fork-test')

const tests = [
  {
    key: 'fork-full-rh-suite',
    prompt: `${context}\n\ncd ${CONTRACTS} && run: forge test --match-path "test/integration/Rh*.t.sol" --fork-url ${RPC}\n(export ROBINHOOD_RPC_URL=${RPC} first)\nCapture pass/fail counts per test suite. If ANY test fails, capture the exact failure trace. Report per schema.`,
    label: 'test:full-rh-fork-suite',
  },
  {
    key: 'fork-live-wire',
    prompt: `${context}\n\nRun the live V5 wiring assertions specifically: cd ${CONTRACTS} && forge test --match-path "test/integration/RhV4LiveStackTest.t.sol" --fork-url ${RPC}\nThis test file was written to verify V4 wiring. It may still hardcode V4 addresses. Read the test file first — if it references ${OLD.Router}, ${OLD.Graduator}, or ${OLD.MultiHookHost} for state assertions, that's an outdated test. Report which addresses the test uses and whether its assertions match V5 reality. If mostly V4-hardcoded, mark as needing update but note it CAN still verify the unchanged-11 contracts.`,
    label: 'test:live-wiring',
  },
  {
    key: 'fork-launch-e2e',
    prompt: `${context}\n\nFork the RH mainnet and simulate a FULL end-to-end launch through the NEW V5 Router (${V5.Router}). Steps:\n1. cast rpc anvil_impersonateAccount + fund a test wallet on a forge script.\n2. Call newRouter.launch with a ERC20 config that installs a bonding curve.\n3. Verify token contract created + curve installed + curve trusted by CurveFactory (via CurveFactory.curveFor(token) returning non-zero).\n4. Buy through the curve until graduation (~2 ETH).\n5. Verify the Graduator (${V5.Graduator}) got called + Uniswap v4 pool spawned using hook ${V5.MultiHookHost}.\n6. Do a post-grad swap through V4SwapRouter (${UNCHANGED.V4SwapRouter}).\n7. Verify swap fee accrues via FeeSplitter (${UNCHANGED.FeeSplitter}).\n\nUse cast + forge script inline. Don't need to write a permanent script — inline forge script piped from a heredoc is fine. Explicitly USE V5 ADDRESSES, not V4.\n\nReport per schema what actually happened at each step.`,
    label: 'test:launch-e2e',
    effort: 'high',
  },
  {
    key: 'fork-fot-blacklist',
    prompt: `${context}\n\nVerify the FoT-blacklist fix works on the NEW router (${V5.Router}). The blacklisted hash currently is 0xa73336ef5d2b7ad3439ea3df1f32c5a34fe653411d944d8d0b005b1cd34e1ac4.\n\nWrite a small forge script or use cast + anvil fork to:\n1. Attempt Router.launch (parent) with configHash=blacklisted + installBondingCurve=true → should revert with Router__CurveIncompatibleModule.\n2. Same for launchWithURU + launchWithWhitelist + launchWithURUAndWhitelist. All should revert.\n\nAll 4 entrypoints MUST reject the blacklisted hash. If any accepts, that's a HIGH regression.\nReport per schema.`,
    label: 'test:fot-blacklist',
    effort: 'high',
  },
  {
    key: 'fork-grad-access',
    prompt: `${context}\n\nVerify the Graduator access-check fix works on the NEW Graduator (${V5.Graduator}). On an RH fork:\n1. Deploy an arbitrary attacker contract that tries to call newGraduator.execute(someToken, 1, 1, 0, 0, address(0)). The attacker is NOT registered in CurveFactory as the curve for someToken. Expected: revert Graduator__NotAuthorizedCurve.\n2. Confirm that a REAL BondingCurve clone (produced via CurveFactory.createCurveWithConfigFor from V5 Router) IS accepted when it calls newGraduator.execute during its own graduation.\n\nReport per schema with the traces.`,
    label: 'test:grad-access',
    effort: 'high',
  },
]

const testResults = await parallel(
  tests.map(t => () =>
    agent(t.prompt, { label: t.label, phase: 'Fork-test', schema: FINDING_SCHEMA, effort: t.effort ?? 'medium' })
  )
)

phase('Synthesize')

const all = [...discoveries, ...testResults].filter(Boolean)
const dump = JSON.stringify(all, null, 2)

const synthesisPrompt = `${context}\n\nHere are 10 independent audit reports on the V5 launchpad. Consolidate them into a single pass/fail matrix.\n\nFor each of the 10 dimensions, report:\n1. Overall status: PASS / FAIL / INCONCLUSIVE\n2. Blockers + Highs only — filter noise\n3. Which dimension actually exercised V5 vs which was surface-level\n4. Anything that CONTRADICTS between reports — those are the highest-value things to flag\n\nEnd with:\n- CAN WE LAUNCH TOKENS ON V5 SAFELY? Yes/No/With-caveats.\n- List of concrete follow-up actions (in priority order).\n\nReports:\n${dump}`

const synthesis = await agent(synthesisPrompt, {
  label: 'synth:final-report',
  phase: 'Synthesize',
  effort: 'high',
})

return { synthesis, raw: all }
