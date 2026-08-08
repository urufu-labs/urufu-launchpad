/// Single source of truth for the pre-launch splash gate.
///
/// When `false`: the home page (/) and the create page (/create) render
/// the <NotLiveYet /> splash instead of their real content. Every other
/// route stays live — people who already own tokens can still trade,
/// claim rewards, view profiles, etc. Just no new launches.
///
/// When `true`: everything is live as normal. The comparison-only flag opens
/// this archived PR1 surface without changing its default pre-launch behavior.
///
/// Removal flow: flip this to `true`, delete web/src/components/NotLiveYet.tsx,
/// clean up the import + branch in web/src/app/page.tsx + web/src/app/create/page.tsx.
export const LAUNCHPAD_LIVE =
  process.env.NEXT_PUBLIC_ENABLE_PR1_COMPARISON_MOCKS === 'true';
