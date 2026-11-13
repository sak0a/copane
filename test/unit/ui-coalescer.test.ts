import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Coalescer } from '../../src/extension/ui/coalescer';

describe('Coalescer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('turns a burst of changes into one update', () => {
    const flush = vi.fn();
    const c = new Coalescer(flush, 40);
    for (let i = 0; i < 100; i++) c.schedule();
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('keeps updating during a long burst, at most once per interval', () => {
    const flush = vi.fn();
    const c = new Coalescer(flush, 40);
    for (let t = 0; t < 200; t += 10) {
      c.schedule();
      vi.advanceTimersByTime(10);
    }
    expect(flush).toHaveBeenCalledTimes(5);
  });

  it('flushNow runs a pending update immediately and only once', () => {
    const flush = vi.fn();
    const c = new Coalescer(flush, 40);
    c.flushNow();
    expect(flush).not.toHaveBeenCalled();
    c.schedule();
    c.flushNow();
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('does nothing after dispose', () => {
    const flush = vi.fn();
    const c = new Coalescer(flush, 40);
    c.schedule();
    c.dispose();
    c.schedule();
    vi.advanceTimersByTime(100);
    expect(flush).not.toHaveBeenCalled();
  });
});
