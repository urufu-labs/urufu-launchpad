/// Small stroke icons for the site shell. 24px grid, currentColor.
const base = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export const IconSearch = () => (<svg {...base}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>);
export const IconChevron = () => (<svg {...base}><path d="m6 9 6 6 6-6" /></svg>);
export const IconSettings = () => (<svg {...base}><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>);
export const IconExplore = () => (<svg {...base}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>);
export const IconTrade = () => (<svg {...base}><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>);
export const IconPlus = () => (<svg {...base}><path d="M12 5v14M5 12h14" /></svg>);
export const IconFeed = () => (<svg {...base}><path d="M4 12h4l3-7 4 14 3-7h2" /></svg>);
export const IconUser = () => (<svg {...base}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>);
export const IconMenu = () => (<svg {...base}><path d="M4 7h16M4 12h16M4 17h16" /></svg>);
export const IconExternal = () => (<svg {...base} width="12" height="12"><path d="M7 17 17 7M8 7h9v9" /></svg>);
export const IconCopy = () => (<svg {...base} width="14" height="14"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>);
export const IconLogout = () => (<svg {...base} width="14" height="14"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" /></svg>);
