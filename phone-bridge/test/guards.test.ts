import { describe, expect, it } from 'vitest';
import { bearerMatches, callExpired, dayKey, isAllowedCaller, reserveOutbound, type CountStore } from '../src/guards';

describe('isAllowedCaller', () => {
  it('matches the allowed number regardless of formatting', () => {
    expect(isAllowedCaller('+34600111222', '+34600111222')).toBe(true);
    expect(isAllowedCaller('+34 600 111 222', '+34600111222')).toBe(true);
    expect(isAllowedCaller('34600111222', '+34600111222')).toBe(true);
  });

  it('rejects other numbers, anonymous callers and an unset allowlist', () => {
    expect(isAllowedCaller('+34600111223', '+34600111222')).toBe(false);
    expect(isAllowedCaller('+346001112220', '+34600111222')).toBe(false);
    expect(isAllowedCaller('anonymous', '+34600111222')).toBe(false);
    expect(isAllowedCaller('', '+34600111222')).toBe(false);
    expect(isAllowedCaller(undefined, '+34600111222')).toBe(false);
    expect(isAllowedCaller('+34600111222', '')).toBe(false);
    expect(isAllowedCaller('', '')).toBe(false);
  });
});

describe('bearerMatches', () => {
  it('accepts only the exact token', async () => {
    expect(await bearerMatches('Bearer s3cret', 's3cret')).toBe(true);
    expect(await bearerMatches('bearer s3cret', 's3cret')).toBe(true);
    expect(await bearerMatches('Bearer s3cret2', 's3cret')).toBe(false);
    expect(await bearerMatches('Bearer ', 's3cret')).toBe(false);
    expect(await bearerMatches('s3cret', 's3cret')).toBe(false);
    expect(await bearerMatches(null, 's3cret')).toBe(false);
  });

  it('never accepts when no token is configured', async () => {
    expect(await bearerMatches('Bearer ', undefined)).toBe(false);
    expect(await bearerMatches('Bearer anything', '')).toBe(false);
  });
});

describe('caps', () => {
  const memory = (): CountStore => {
    const m = new Map<string, number>();
    return { count: d => m.get(d) ?? 0, increment: d => void m.set(d, (m.get(d) ?? 0) + 1) };
  };

  it('allows exactly max outbound calls per day then refuses', () => {
    const store = memory();
    const results = Array.from({ length: 12 }, () => reserveOutbound(store, '2026-11-26', 10));
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(results.slice(10)).toEqual([false, false]);
  });

  it('starts a fresh count on a new day', () => {
    const store = memory();
    for (let i = 0; i < 3; i++) reserveOutbound(store, '2026-11-26', 3);
    expect(reserveOutbound(store, '2026-11-26', 3)).toBe(false);
    expect(reserveOutbound(store, '2026-11-27', 3)).toBe(true);
  });

  it('computes the day in the configured timezone', () => {
    const lateUtc = Date.UTC(2026, 10, 26, 23, 30);
    expect(dayKey(lateUtc, 'UTC')).toBe('2026-11-26');
    expect(dayKey(lateUtc, 'Europe/Madrid')).toBe('2026-11-27');
  });

  it('expires a call at the limit', () => {
    expect(callExpired(0, 599_999, 600_000)).toBe(false);
    expect(callExpired(0, 600_000, 600_000)).toBe(true);
  });
});
