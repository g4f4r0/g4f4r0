const b64 = (bytes: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(bytes)));

export async function signWith(
  privateKey: CryptoKey,
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<{ signature: string; timestamp: string }> {
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(`${timestamp}|${body}`));
  return { signature: b64(sig), timestamp: String(timestamp) };
}

export async function makeKeys(): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return { publicKey: b64((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer), privateKey: pair.privateKey };
}
