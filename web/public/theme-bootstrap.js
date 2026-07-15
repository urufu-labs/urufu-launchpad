// Runs before React hydration to prevent a light→dark FOUC. Sourced by <script src>
// in the root layout head so React never sees a <script> node in its tree (Next 16 warns
// on <script> tags rendered inside React components). Keep the STORAGE_KEY in sync with
// web/src/components/ThemeToggle.tsx.
(function () {
  try {
    var stored = localStorage.getItem('urufu-theme');
    var theme =
      stored === 'dark' || stored === 'light'
        ? stored
        : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
