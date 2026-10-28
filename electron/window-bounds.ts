export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export const DEFAULT_SIZE: Size = { width: 420, height: 640 };
export const MIN_SIZE: Size = { width: 340, height: 420 };

/** Shrink the requested size to fit the work area, but never below MIN_SIZE. */
export function clampSize(requested: Size, workArea: Rect): Size {
  return {
    width: Math.max(MIN_SIZE.width, Math.min(requested.width, workArea.width)),
    height: Math.max(MIN_SIZE.height, Math.min(requested.height, workArea.height)),
  };
}

/** Place the window in the top-right corner of the work area with a margin. */
export function initialBounds(workArea: Rect, requested: Size = DEFAULT_SIZE, margin = 24): Rect {
  return presetBounds('top-right', workArea, requested, margin);
}

export type Preset = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'center';

/** Place a window of the requested size at a corner (or the centre) of the work area. */
export function presetBounds(preset: Preset, workArea: Rect, requested: Size, margin = 24): Rect {
  const size = clampSize(requested, workArea);
  const freeX = Math.max(0, workArea.width - size.width);
  const freeY = Math.max(0, workArea.height - size.height);
  const left = Math.min(margin, freeX);
  const right = Math.max(0, freeX - margin);
  const top = Math.min(margin, freeY);
  const bottom = Math.max(0, freeY - margin);
  const offsets: Record<Preset, [number, number]> = {
    'top-right': [right, top],
    'top-left': [left, top],
    'bottom-right': [right, bottom],
    'bottom-left': [left, bottom],
    center: [freeX / 2, freeY / 2],
  };
  const [dx, dy] = offsets[preset];
  return {
    x: Math.round(workArea.x + dx),
    y: Math.round(workArea.y + dy),
    width: size.width,
    height: size.height,
  };
}

/**
 * Restore saved bounds only if the title bar would still be reachable on one
 * of the current displays (monitors may have been unplugged or rearranged).
 */
export function restoreBounds(saved: Rect | null, workAreas: Rect[]): Rect | null {
  if (!saved || workAreas.length === 0) return null;
  const titleBar: Rect = { x: saved.x + 40, y: saved.y, width: Math.max(1, saved.width - 80), height: 40 };
  const visible = workAreas.find((wa) => overlapArea(titleBar, wa) >= Math.min(titleBar.width, 100) * 20);
  if (!visible) return null;
  const size = clampSize(saved, visible);
  return { x: saved.x, y: saved.y, width: size.width, height: size.height };
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
