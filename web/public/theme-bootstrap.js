// Runs before React hydration to prevent a light→dark FOUC. Sourced by next/script in
// the root layout head so React does not warn on raw <script> tags rendered inside
// components. Keep the STORAGE_KEY in sync with web/src/components/ThemeToggle.tsx.
//
// Light is the brand default — the paper/cream/pink palette is what the site is designed
// around. Only opt into dark if the user has explicitly toggled it (prefers-color-scheme
// is ignored so a dark-mode OS doesn't override the intended look for first-time visitors).
(function () {
  try {
    var stored = localStorage.getItem('urufu-theme');
    var theme = stored === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (_err) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
