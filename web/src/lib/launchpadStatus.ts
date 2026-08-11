/// Single source of truth for the pre-launch splash gate.
///
/// When `false`: the home page (/) and the create page (/create) render
/// the <NotLiveYet /> splash instead of their real content. Every other
/// route stays live — people who already own tokens can still trade,
/// claim rewards, view profiles, etc. Just no new launches.
///
/// When `true`: everything is live as normal.
///
/// Removal flow: flip this to `true`, delete web/src/components/NotLiveYet.tsx,
/// clean up the import + branch in web/src/app/page.tsx + web/src/app/create/page.tsx.
export const LAUNCHPAD_LIVE = false;

/// Block number the /flywheel dashboard treats as the "start of history"
/// on Robinhood chain. Events (splits, buybacks, conversions) at a lower
/// block are hidden from the totals + activity feed. This is set well in
/// the future by default so the page reads as zeroed while we're testing.
///
/// **When flipping LAUNCHPAD_LIVE to true**: right before enabling, read
/// the current RH block via `cast block-number --rpc-url $ROBINHOOD_RPC_URL`
/// and set this to that value. The page will start counting real launches
/// from that block forward.
///
/// A very high default (2^40) is safer than 0 — 0 would make every past
/// test-launch show up. If you forget to lower it before launch, the
/// dashboard reads as "0 URU / 0 ETH / 0 ETH" which is confusing but
/// never misleading. Lowering it later is a one-line PR.
export const FLYWHEEL_HISTORY_START_BLOCK = 1_099_511_627_776; // 2^40
