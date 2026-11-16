import { describe, expect, it } from 'vitest';
import { syncPercent } from '../../src/shared/room';

describe('syncPercent', () => {
  it('rounds down, so 100 only ever means everything is here', () => {
    expect(syncPercent({ have: 12, total: 18 })).toBe(66);
    expect(syncPercent({ have: 269, total: 270 })).toBe(99);
    expect(syncPercent({ have: 18, total: 18 })).toBe(100);
    expect(syncPercent({ have: 0, total: 18 })).toBe(0);
  });

  it('calls nothing to fetch complete', () => {
    expect(syncPercent({ have: 0, total: 0 })).toBe(100);
  });
});
