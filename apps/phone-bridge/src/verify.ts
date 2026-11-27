const TOLERANCE_SECONDS = 300;

function fromBase64(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function verifyTelnyxSignature(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  publicKeyBase64: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!signature || !timestamp || !publicKeyBase64) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > TOLERANCE_SECONDS) return false;
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64(publicKeyBase64), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      fromBase64(signature),
      new TextEncoder().encode(`${timestamp}|${rawBody}`),
    );
  } catch {
    return false;
  }
}
