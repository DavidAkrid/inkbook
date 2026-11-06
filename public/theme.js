// Applies an artist's appearance (Settings → Appearance) to the page by setting
// data-* attributes on <html>; themes.css does the rest. Loaded in <head> so the
// dashboard can apply its cached look before first paint.
(function () {
  const THEMES = ['classic', 'terminal-green', 'terminal-amber', 'terminal-purple', 'sunset'];
  const FONTS  = ['default', 'mono', 'serif', 'gothic'];
  const CACHE_KEY = 'inkbook-appearance';
  const root = document.documentElement;

  function setAttr(name, value) {
    if (value) root.setAttribute(name, value === true ? '' : value);
    else root.removeAttribute(name);
  }

  /** a = { theme, scanlines, glow, heading_font } — unknown values fall back to the default look */
  function applyAppearance(a) {
    a = a || {};
    const theme = THEMES.includes(a.theme) ? a.theme : 'classic';
    const font  = FONTS.includes(a.heading_font) ? a.heading_font : 'default';
    setAttr('data-theme', theme === 'classic' ? null : theme);
    setAttr('data-font',  font  === 'default' ? null : font);
    setAttr('data-scanlines', !!a.scanlines);
    setAttr('data-glow',      !!a.glow);
  }

  // Per-browser cache so the artist's dashboard doesn't flash the default look on load.
  // Storage can be unavailable (private mode, blocked site data) — the page still works.
  function cacheAppearance(a) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(a)); } catch (e) { /* ignore */ }
  }
  function applyCachedAppearance() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) applyAppearance(JSON.parse(raw));
    } catch (e) { /* ignore */ }
  }

  window.InkbookTheme = { THEMES, FONTS, applyAppearance, cacheAppearance, applyCachedAppearance };
})();
