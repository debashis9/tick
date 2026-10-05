// Applies the saved theme before first paint (mirrored from settings by theme.js). A separate
// file, not inline, so the Content-Security-Policy can forbid inline scripts.
try {
  var t = localStorage.getItem('tick.theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) { /* private mode */ }
