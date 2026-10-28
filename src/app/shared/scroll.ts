/** Nearest ancestor that scrolls vertically. */
export function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === 'auto' || overflowY === 'scroll') return p;
  }
  return null;
}

/**
 * Scroll the nearest scroll container so `el` starts just below its top edge.
 * Unless `always` is set, nothing moves when the start of `el` is already
 * comfortably visible. Returns true when it scrolled.
 */
export function revealStart(el: HTMLElement, { always = false, margin = 8 } = {}): boolean {
  const scroller = scrollParent(el);
  if (!scroller) return false;
  const view = scroller.getBoundingClientRect();
  const top = el.getBoundingClientRect().top;
  // "Comfortably visible": in view with room for a few lines below it.
  const room = Math.min(120, view.height / 3);
  if (!always && top >= view.top && top <= view.bottom - room) return false;
  const before = scroller.scrollTop;
  scroller.scrollTop += top - view.top - margin;
  return scroller.scrollTop !== before;
}
