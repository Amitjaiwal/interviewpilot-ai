import { describe, expect, it } from 'vitest';
import { DEFAULT_SIZE, MIN_SIZE, clampSize, initialBounds, presetBounds, restoreBounds } from '../../electron/window-bounds';

const fullHd = { x: 0, y: 0, width: 1920, height: 1040 };

describe('initialBounds', () => {
  it('places the default window in the top-right corner with a margin', () => {
    expect(initialBounds(fullHd)).toEqual({
      x: 1920 - DEFAULT_SIZE.width - 24,
      y: 24,
      width: DEFAULT_SIZE.width,
      height: DEFAULT_SIZE.height,
    });
  });

  it('respects a work area that does not start at the origin (secondary monitor)', () => {
    const b = initialBounds({ x: -1280, y: 100, width: 1280, height: 984 });
    expect(b.x).toBe(-1280 + 1280 - DEFAULT_SIZE.width - 24);
    expect(b.y).toBe(124);
  });

  it('stays inside a tiny work area', () => {
    const b = initialBounds({ x: 0, y: 0, width: 400, height: 500 });
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
  });
});

describe('clampSize', () => {
  it('shrinks to the work area', () => {
    expect(clampSize({ width: 5000, height: 5000 }, fullHd)).toEqual({ width: 1920, height: 1040 });
  });

  it('never goes below the minimum size', () => {
    expect(clampSize({ width: 10, height: 10 }, fullHd)).toEqual(MIN_SIZE);
  });
});

describe('presetBounds', () => {
  const size = { width: 400, height: 600 };

  it('places the window in each corner with a margin', () => {
    expect(presetBounds('top-left', fullHd, size)).toMatchObject({ x: 24, y: 24 });
    expect(presetBounds('bottom-right', fullHd, size)).toMatchObject({ x: 1920 - 400 - 24, y: 1040 - 600 - 24 });
    expect(presetBounds('bottom-left', fullHd, size)).toMatchObject({ x: 24, y: 1040 - 600 - 24 });
  });

  it('centres the window', () => {
    expect(presetBounds('center', fullHd, size)).toMatchObject({ x: 760, y: 220 });
  });
});

describe('restoreBounds', () => {
  it('keeps saved bounds that are on a connected display', () => {
    const saved = { x: 100, y: 100, width: 500, height: 700 };
    expect(restoreBounds(saved, [fullHd])).toEqual(saved);
  });

  it('discards bounds whose title bar is off every display (monitor unplugged)', () => {
    expect(restoreBounds({ x: 3000, y: 100, width: 500, height: 700 }, [fullHd])).toBeNull();
    expect(restoreBounds({ x: 100, y: -500, width: 500, height: 700 }, [fullHd])).toBeNull();
  });

  it('returns null without saved bounds', () => {
    expect(restoreBounds(null, [fullHd])).toBeNull();
  });
});
