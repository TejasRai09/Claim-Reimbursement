// File: public/themeToggle.js
// ---------------------------------------------------------------------------
// • Works with the new CSS that applies "theme-dark" / "theme-light" classes
// • Respects the user's OS‑level preference on first visit
// • Persists the choice in localStorage under "ui-theme"
// • Updates Feather icon automatically
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  const HTML         = document.documentElement;           // <html>
  const toggleBtn    = document.getElementById('themeToggleBtn');
  const STORAGE_KEY  = 'ui-theme';

  /* --------------------------------------------------------------
     1.  Helper: set class, store choice, swap Feather icon
  ----------------------------------------------------------------*/
  function applyTheme(theme) {
    const oldTheme = theme === 'light' ? 'theme-dark' : 'theme-light';
    HTML.classList.replace(oldTheme, `theme-${theme}`);            // swap class
    localStorage.setItem(STORAGE_KEY, theme);                      // persist
    // icon swap
    toggleBtn.innerHTML = theme === 'light'
      ? '<i data-feather="moon"></i>'
      : '<i data-feather="sun"></i>';
    feather.replace();                                             // refresh icons
  }

  /* --------------------------------------------------------------
     2.  Decide the initial theme on first load
         A) saved in localStorage? use it
         B) otherwise: match OS preference
         C) default to dark
  ----------------------------------------------------------------*/
  const savedTheme = localStorage.getItem(STORAGE_KEY);
  const prefersDark = window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches;   /* :contentReference[oaicite:0]{index=0} */

  const initialTheme =
        savedTheme               ? savedTheme :                     // user choice
        (prefersDark ? 'dark' : 'light');                           // system pref

  // ensure exactly one theme class on <html>
  HTML.classList.add(`theme-${initialTheme}`);
  HTML.classList.remove(initialTheme === 'dark' ? 'theme-light' : 'theme-dark');

  // set the right icon on first paint
  toggleBtn.innerHTML = initialTheme === 'light'
      ? '<i data-feather="moon"></i>'
      : '<i data-feather="sun"></i>';
  feather.replace();                                                /* :contentReference[oaicite:1]{index=1} */

  /* --------------------------------------------------------------
     3.  Toggle handler
  ----------------------------------------------------------------*/
  toggleBtn.addEventListener('click', () => {
    const current = HTML.classList.contains('theme-light') ? 'light' : 'dark';
    const next    = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);                                               /* classList.toggle best practice :contentReference[oaicite:2]{index=2} */
  });

  /* --------------------------------------------------------------
     4.  Optional: react to changes in system preference
         (e.g. user flips macOS dark‑mode switch while tab is open)
  ----------------------------------------------------------------*/
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)')
          .addEventListener('change', e => {
            if (!localStorage.getItem(STORAGE_KEY)) {               // honour user override
              applyTheme(e.matches ? 'dark' : 'light');
            }
          });
  }
});
