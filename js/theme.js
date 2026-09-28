// Theme lives in settings (IndexedDB), with a localStorage mirror so index.html can
// apply it before the first paint instead of flashing the wrong theme.

const COLORS = { light: '#F4F5F2', dark: '#0D0F0E' };

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
  try { localStorage.setItem('tick.theme', theme); } catch { /* private mode: fine */ }
  const dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => {
    // An explicit choice overrides both media-specific tags; "system" restores them.
    m.content = theme === 'system' ? COLORS[m.media.includes('dark') ? 'dark' : 'light'] : COLORS[dark ? 'dark' : 'light'];
  });
}
