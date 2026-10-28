/// Shared copy and formatting for the /swarms pages.

export const STAGE_LABEL: Record<string, string> = {
  joining: 'Open',
  waiting_for_launch: 'Vote passed',
  ready_to_join_batch: 'Launching',
  in_batch: 'In the launch',
  claimable: 'Done',
  failed: 'Did not go ahead',
  closed: 'Closed',
};

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function timeLeft(ts: number): string {
  const s = ts - Math.floor(Date.now() / 1000);
  if (s <= 0) return 'ended';
  if (s < 3600) return `${Math.ceil(s / 60)}m left`;
  if (s < 86400) return `${Math.floor(s / 3600)}h left`;
  return `${Math.floor(s / 86400)}d left`;
}

export function trimEth(v: string, places = 4): string {
  const [whole, frac = ''] = v.split('.');
  const f = frac.slice(0, places).replace(/0+$/, '');
  return f ? `${whole}.${f}` : whole;
}
