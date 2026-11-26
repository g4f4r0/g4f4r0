export function normalizeNumber(raw: string | undefined | null): string {
  if (!raw || !/^\+?[\d\s().-]+$/.test(raw.trim())) return '';
  const digits = raw.replace(/[^\d]/g, '');
  return digits ? '+' + digits : '';
}

export function isAllowedCaller(from: string | undefined | null, allowed: string): boolean {
  const a = normalizeNumber(allowed);
  return a !== '' && normalizeNumber(from) === a;
}

const enc = new TextEncoder();

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value)));
}

export async function bearerMatches(header: string | null, token: string | undefined): Promise<boolean> {
  if (!token || !header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const [a, b] = await Promise.all([digest(match[1]), digest(token)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export interface CountStore {
  count(day: string): number;
  increment(day: string): void;
}

export function dayKey(now: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(now),
  );
}

export function reserveOutbound(store: CountStore, day: string, max: number): boolean {
  if (store.count(day) >= max) return false;
  store.increment(day);
  return true;
}

export function callExpired(startedAt: number, now: number, maxMs: number): boolean {
  return now - startedAt >= maxMs;
}
