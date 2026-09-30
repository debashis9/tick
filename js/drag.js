// Press and hold a card to lift it. Let go without moving to edit the habit; move to drag it
// to a new place in its list. A plain tap still ticks, and a quick swipe still scrolls.

const HOLD = 450, SLOP = 8;

export function bindDrag(root, { onHold, onDrop }) {
  let s = null, suppressClick = false;

  const clear = () => {
    if (!s) return;
    clearTimeout(s.timer);
    cancelAnimationFrame(s.raf);
    s.card.classList.remove('lifted');
    s.list?.classList.remove('sorting');
    s = null;
  };

  function lift() {
    s.lifted = true;
    s.card.classList.add('lifted');
    navigator.vibrate?.(15);
    try { s.card.setPointerCapture(s.pointerId); } catch { /* pointer already gone */ }
  }

  function startDrag() {
    s.dragging = true;
    s.list = s.card.parentElement;
    s.cards = [...s.list.children].filter(c => c.classList.contains('card'));
    s.from = s.to = s.cards.indexOf(s.card);
    s.rects = s.cards.map(c => { const r = c.getBoundingClientRect(); return { top: r.top + scrollY, bottom: r.bottom + scrollY }; });
    const gap = s.rects.length > 1 ? s.rects[1].top - s.rects[0].bottom : 0;
    s.shift = s.rects[s.from].bottom - s.rects[s.from].top + gap;
    s.list.classList.add('sorting');
    s.raf = requestAnimationFrame(autoScroll);
  }

  function update() {
    const r = s.rects, f = s.from, last = r.length - 1;
    const dy = Math.min(r[last].bottom - r[f].bottom, Math.max(r[0].top - r[f].top, s.y + scrollY - s.pageY0));
    const mid = (r[f].top + r[f].bottom) / 2 + dy;
    let to = f;
    for (let i = f + 1; i <= last; i++) if (mid > (r[i].top + r[i].bottom) / 2) to = i;
    for (let i = f - 1; i >= 0; i--) if (mid < (r[i].top + r[i].bottom) / 2) to = i;
    s.to = to;
    s.card.style.transform = `translateY(${dy}px)`;
    s.cards.forEach((c, i) => {
      if (i === f) return;
      const shift = f < i && i <= to ? -s.shift : to <= i && i < f ? s.shift : 0;
      c.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  }

  // Scroll the page while the card is held near the top or bottom edge.
  function autoScroll() {
    if (!s?.dragging) return;
    const dir = s.y < 90 ? -1 : s.y > innerHeight - 130 ? 1 : 0;
    if (dir) { scrollBy(0, dir * 8); update(); }
    s.raf = requestAnimationFrame(autoScroll);
  }

  function drop() {
    const { cards, from, to, rects, card } = s;
    const target = to > from ? rects[to].bottom - rects[from].bottom : to < from ? rects[to].top - rects[from].top : 0;
    card.style.transition = 'transform .16s var(--ease)';
    card.style.transform = `translateY(${target}px)`;
    const ids = cards.map(c => c.dataset.id);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    const moved = to !== from;
    cancelAnimationFrame(s.raf);
    s = null;
    setTimeout(() => {
      card.classList.remove('lifted');
      card.parentElement?.classList.remove('sorting');
      if (moved) onDrop(ids);
      else cards.forEach(c => { c.style.transform = ''; });
    }, 160);
  }

  root.addEventListener('pointerdown', e => {
    const card = e.target.closest('.card');
    if (s && !s.dragging) clear();
    if (!card || e.button > 0 || e.target.closest('button') || s) return;
    s = { card, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, y: e.clientY, pageY0: e.clientY + scrollY, lifted: false, dragging: false };
    s.timer = setTimeout(lift, HOLD);
  });

  root.addEventListener('pointermove', e => {
    if (!s || e.pointerId !== s.pointerId) return;
    s.y = e.clientY;
    if (!s.lifted) {
      if (Math.hypot(e.clientX - s.x0, e.clientY - s.y0) > SLOP) clear();  // a scroll, not a hold
      return;
    }
    if (!s.dragging) {
      if (Math.abs(e.clientY - s.y0) < SLOP) return;
      startDrag();
    }
    update();
  });

  root.addEventListener('pointerup', e => {
    if (!s || e.pointerId !== s.pointerId) return;
    if (!s.lifted) return clear();
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 400);
    if (s.dragging) return drop();
    const card = s.card;
    clear();
    onHold(card);
  });

  root.addEventListener('pointerleave', () => { if (s && !s.lifted) clear(); });

  root.addEventListener('pointercancel', () => {
    if (s?.dragging) s.cards.forEach(c => { c.style.transform = ''; });
    clear();
  });

  // While a card is lifted, a finger moving must drag it, not scroll the page.
  root.addEventListener('touchmove', e => { if (s?.lifted) e.preventDefault(); }, { passive: false });
  // The click that follows a hold or a drag isn't a tap.
  root.addEventListener('click', e => {
    if (!suppressClick) return;
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
  root.addEventListener('contextmenu', e => { if (e.target.closest('.card')) e.preventDefault(); });
}
