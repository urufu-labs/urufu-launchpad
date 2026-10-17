/* Shared mockup shell: theme, header, mobile tab bar, sample data, motion helpers.
   Mockup only. In the app these become React components and real indexer data. */
(function () {
  var KEY = 'urufu-mock-theme';
  try {
    var saved = localStorage.getItem(KEY);
    var q = new URLSearchParams(location.search).get('theme');
    if (q === 'dark' || (!q && saved === 'dark')) document.documentElement.setAttribute('data-theme', 'dark');
  } catch (e) {}

  var IPFS = 'https://blush-selective-urial-386.mypinata.cloud/ipfs/';
  window.TOKENS = [
    { name: 'urufu PEPE', sym: 'UPEPE', img: IPFS + 'QmSyTmB1yCoZMwgX8NdWCYDWXGGgd8iNxBUJFdaUYrNztR', mcap: 25600, chg: 18.4, curve: 64, vol: 3.1, age: '2h', trades: 212, holders: 88 },
    { name: 'lambo', sym: 'LAMBO', img: IPFS + 'QmceBikJsLfdgWCCKSW2iF7h6Kf42F7fY6cPESDikQQLWD', mcap: 26200, chg: 9.2, curve: 71, vol: 2.4, age: '5h', trades: 173, holders: 61 },
    { name: 'luv', sym: 'LUV', img: IPFS + 'QmQNmXcsirqcifrQaJw415W5BhsP7wuyuqUznfHE8oxVTJ', mcap: 39900, chg: 4.1, curve: 100, vol: 5.8, age: '1d', trades: 402, holders: 140, grad: true },
    { name: 'sheepcat', sym: 'SCAT', img: IPFS + 'QmbhT6Vqmhc5rjqUpRvsCqDQt3kviGSeEfZb7H7nBzXBkP', mcap: 25600, chg: -3.6, curve: 38, vol: 0.9, age: '9h', trades: 54, holders: 31 },
    { name: 'pikachu', sym: 'PIKA', img: IPFS + 'QmUpv1AeEJmvBHy4AZz1QjsDcj5jn1r8QY35P98XfY3vKZ', mcap: 6200, chg: 2.2, curve: 12, vol: 0.3, age: '3d', trades: 27, holders: 14 },
    { name: 'Seven Wolves Biting on a Lamb', sym: 'AGNUS', img: IPFS + 'QmTbAmbY6EvTw8GjRCq2wThL3M1tmtfn7pCE8yTRTfrpC7', mcap: 6030, chg: 0, curve: 6, vol: 0.1, age: '4d', trades: 5, holders: 4 },
    { name: 'baa', sym: 'BAA', img: IPFS + 'QmWqL3nwb73RKWvs4oyoFPDjddX4Qm3rCiTNCfLFRtUxeT', mcap: 25800, chg: 11.7, curve: 55, vol: 1.7, age: '6h', trades: 98, holders: 42 },
    { name: 'post it', sym: 'POSTIT', img: IPFS + 'QmWLbj4xFyG3D1Ag2NnEhrkQhXaKJUvFz1BsfsN7SNsHNk', mcap: 25600, chg: -8.1, curve: 41, vol: 1.1, age: '12h', trades: 66, holders: 29 },
    { name: 'MikuGrimesComputerDragonSexInu', sym: 'TESLA', img: IPFS + 'QmZzA4vyf6xr2xDhiUdh4rGEwjMLdUmWGncYjEBb1GhXTV', mcap: 4830, chg: 0, curve: 0, vol: 0, age: '20m', trades: 0, holders: 1 },
    { name: 'xd', sym: 'XD', img: IPFS + 'QmdAcVQANtjfXebLKQPxp3EYpr2HrAWo1jVTu6EJQJB3Xb', mcap: 6050, chg: 1.4, curve: 9, vol: 0.2, age: '2d', trades: 11, holders: 7 },
    { name: 'iboy', sym: 'IBOY', img: IPFS + 'QmQvxgTvGJSo5WgFQAg2Jsn9A6WajyxhUpew5RMgDNXiqG', mcap: 6050, chg: -1.2, curve: 8, vol: 0.2, age: '2d', trades: 9, holders: 6 }
  ];

  window.fmtUsd = function (n) {
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n.toFixed(2);
  };
  window.fmtPct = function (n) { return (n > 0 ? '+' : '') + n.toFixed(1) + '%'; };
  window.shortAddr = function () {
    var h = '0123456789abcdef', s = '0x';
    for (var i = 0; i < 4; i++) s += h[Math.floor(Math.random() * 16)];
    s += '…';
    for (var j = 0; j < 4; j++) s += h[Math.floor(Math.random() * 16)];
    return s;
  };

  var ICON = {
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    explore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    trade: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    chev: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'
  };
  window.ICON = ICON;

  function header(page) {
    function cur(p) { return page === p ? ' aria-current="page"' : ''; }
    return '' +
      '<header class="topbar">' +
        '<a class="brand" href="home.html"><span class="brand-mark">u</span><span>urufu<b>labs</b></span></a>' +
        '<nav class="nav" aria-label="Primary">' +
          '<a href="home.html"' + cur('home') + '>Explore</a>' +
          '<a href="trade.html"' + cur('trade') + '>Trade</a>' +
          '<a href="create.html"' + cur('create') + '>Launch</a>' +
          '<a href="#">Flywheel</a>' +
        '</nav>' +
        '<label class="search">' + ICON.search.replace('<svg', '<svg width="15" height="15"') +
          '<input placeholder="Search tokens, collections, wallets" aria-label="Search" />' +
          '<span class="kbd">⌘K</span></label>' +
        '<div class="topbar-right">' +
          '<div class="seg hide-sm" role="group" aria-label="Price unit"><button aria-pressed="true">USD</button><button aria-pressed="false">ETH</button></div>' +
          '<button class="chain-pill hide-sm"><span class="chain-dot"></span>Robinhood' + ICON.chev + '</button>' +
          '<button class="icon-btn" id="themeBtn" aria-label="Toggle theme"></button>' +
          '<button class="btn btn-ink">Connect wallet</button>' +
        '</div>' +
      '</header>';
  }

  function tabbar(page) {
    function cur(p) { return page === p ? ' aria-current="page"' : ''; }
    return '<nav class="tabbar" aria-label="Primary">' +
      '<a href="home.html"' + cur('home') + '>' + ICON.explore + 'Explore</a>' +
      '<a href="trade.html"' + cur('trade') + '>' + ICON.trade + 'Trade</a>' +
      '<a href="create.html"' + cur('create') + '>' + ICON.plus + 'Launch</a>' +
      '<a href="#">' + ICON.user + 'Profile</a>' +
    '</nav>';
  }

  function mockNote(page) {
    function cur(p) { return page === p ? ' aria-current="page"' : ''; }
    return '<div class="mock-note" aria-label="Mockup pages">' +
      '<a href="home.html"' + cur('home') + '>Home</a>' +
      '<a href="trade.html"' + cur('trade') + '>Trade</a>' +
      '<a href="create.html"' + cur('create') + '>Create</a>' +
    '</div>';
  }

  function paintThemeBtn() {
    var b = document.getElementById('themeBtn');
    if (!b) return;
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    b.innerHTML = dark ? ICON.sun : ICON.moon;
  }

  window.addEventListener('DOMContentLoaded', function () {
    var page = document.body.getAttribute('data-page');
    document.body.insertAdjacentHTML('afterbegin', header(page));
    document.body.insertAdjacentHTML('beforeend', tabbar(page) + mockNote(page));
    paintThemeBtn();
    document.getElementById('themeBtn').addEventListener('click', function () {
      var root = document.documentElement;
      var dark = root.getAttribute('data-theme') === 'dark';
      if (dark) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', 'dark');
      try { localStorage.setItem(KEY, dark ? 'light' : 'dark'); } catch (e) {}
      paintThemeBtn();
      document.dispatchEvent(new CustomEvent('themechange'));
    });
    // Segmented controls in the shell toggle visually.
    document.querySelectorAll('.seg').forEach(function (seg) {
      seg.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b || !seg.contains(b)) return;
        seg.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        seg.dispatchEvent(new CustomEvent('segchange', { detail: b.textContent.trim(), bubbles: true }));
      });
    });
  });

  window.cssVar = function (name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  };
  window.reducedMotion = function () {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  };

  /* Count a number up from 0, used for stats. fmt turns the value into text. */
  window.countUp = function (el, to, fmt, dur) {
    if (!window.gsap || reducedMotion()) { el.textContent = fmt(to); return; }
    var o = { v: 0 };
    gsap.to(o, { v: to, duration: dur || 1.1, ease: 'power3.out', onUpdate: function () { el.textContent = fmt(o.v); } });
  };

  /* Tab underline that slides between tabs. */
  window.wireTabs = function (tabs, onChange) {
    var ink = document.createElement('span'); ink.className = 'tabs-ink'; tabs.appendChild(ink);
    function place(btn, animate) {
      var r = btn.getBoundingClientRect(), p = tabs.getBoundingClientRect();
      var props = { x: r.left - p.left, width: r.width };
      if (window.gsap && animate && !reducedMotion()) gsap.to(ink, Object.assign({ duration: 0.28, ease: 'power3.out' }, props));
      else if (window.gsap) gsap.set(ink, props);
      else { ink.style.left = props.x + 'px'; ink.style.width = props.width + 'px'; }
    }
    var first = tabs.querySelector('[aria-selected="true"]');
    requestAnimationFrame(function () { place(first, false); });
    window.addEventListener('resize', function () { place(tabs.querySelector('[aria-selected="true"]'), false); });
    tabs.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      tabs.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-selected', x === b ? 'true' : 'false'); });
      place(b, true);
      if (onChange) onChange(b.dataset.tab || b.textContent.trim());
    });
  };
})();
