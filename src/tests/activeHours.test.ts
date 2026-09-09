import { describe, it, expect } from 'vitest';
import { isInActiveHours } from '../providers/providerManager.js';

const TZ = 'America/Argentina/Buenos_Aires'; // UTC-3

function makeDate(isoStr: string): Date {
  return new Date(isoStr);
}

describe('isInActiveHours', () => {
  const start = '07:00';
  const end = '22:00';

  it('returns true at 12:00 (midday)', () => {
    // 2026-01-15 12:00 ART = 15:00 UTC
    const d = makeDate('2026-01-15T15:00:00Z');
    expect(isInActiveHours(start, end, TZ, d)).toBe(true);
  });

  it('returns true at exactly start time (07:00)', () => {
    // 07:00 ART = 10:00 UTC
    const d = makeDate('2026-01-15T10:00:00Z');
    expect(isInActiveHours(start, end, TZ, d)).toBe(true);
  });

  it('returns false at exactly end time (22:00)', () => {
    // 22:00 ART = 01:00 UTC next day
    const d = makeDate('2026-01-16T01:00:00Z');
    expect(isInActiveHours(start, end, TZ, d)).toBe(false);
  });

  it('returns false at 23:00 (night)', () => {
    // 23:00 ART = 02:00 UTC next day
    const d = makeDate('2026-01-16T02:00:00Z');
    expect(isInActiveHours(start, end, TZ, d)).toBe(false);
  });

  it('returns false at 03:00 (early morning)', () => {
    // 03:00 ART = 06:00 UTC
    const d = makeDate('2026-01-15T06:00:00Z');
    expect(isInActiveHours(start, end, TZ, d)).toBe(false);
  });

  it('returns false one minute before start (06:59)', () => {
    // 06:59 ART = 09:59 UTC
    const d = makeDate('2026-01-15T09:59:00Z');
    expect(isInActiveHours(start, end, TZ, d)).toBe(false);
  });

  it('returns true one minute after start (07:01)', () => {
    // 07:01 ART = 10:01 UTC
    const d = makeDate('2026-01-15T10:01:00Z');
    expect(isInActiveHours(start, end, TZ, d)).toBe(true);
  });

  it('handles midnight-crossing window (22:00–06:00)', () => {
    const nightStart = '22:00';
    const nightEnd = '06:00';

    // 23:00 ART = 02:00 UTC — inside the night window
    const d1 = makeDate('2026-01-16T02:00:00Z');
    expect(isInActiveHours(nightStart, nightEnd, TZ, d1)).toBe(true);

    // 12:00 ART = 15:00 UTC — outside the night window
    const d2 = makeDate('2026-01-15T15:00:00Z');
    expect(isInActiveHours(nightStart, nightEnd, TZ, d2)).toBe(false);
  });

  it('works with UTC timezone', () => {
    const d = makeDate('2026-01-15T12:00:00Z'); // 12:00 UTC
    expect(isInActiveHours('07:00', '22:00', 'UTC', d)).toBe(true);
  });
});
