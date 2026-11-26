import { describe, expect, it } from 'vitest';
import { verifyTelnyxSignature } from '../src/verify';
import { makeKeys, signWith } from './helpers';

const body = JSON.stringify({ data: { event_type: 'call.initiated', payload: { call_control_id: 'abc' } } });

describe('verifyTelnyxSignature', () => {
  it('accepts a correctly signed body', async () => {
    const { publicKey, privateKey } = await makeKeys();
    const { signature, timestamp } = await signWith(privateKey, body);
    expect(await verifyTelnyxSignature(body, signature, timestamp, publicKey)).toBe(true);
  });

  it('rejects a body changed after signing', async () => {
    const { publicKey, privateKey } = await makeKeys();
    const { signature, timestamp } = await signWith(privateKey, body);
    expect(await verifyTelnyxSignature(body.replace('abc', 'xyz'), signature, timestamp, publicKey)).toBe(false);
  });

  it('rejects a signature made with another key', async () => {
    const real = await makeKeys();
    const forger = await makeKeys();
    const { signature, timestamp } = await signWith(forger.privateKey, body);
    expect(await verifyTelnyxSignature(body, signature, timestamp, real.publicKey)).toBe(false);
  });

  it('rejects a replayed timestamp outside the five minute window', async () => {
    const { publicKey, privateKey } = await makeKeys();
    const old = Math.floor(Date.now() / 1000) - 301;
    const { signature, timestamp } = await signWith(privateKey, body, old);
    expect(await verifyTelnyxSignature(body, signature, timestamp, publicKey)).toBe(false);
  });

  it('rejects missing headers, garbage signatures and a missing key', async () => {
    const { publicKey, privateKey } = await makeKeys();
    const { signature, timestamp } = await signWith(privateKey, body);
    expect(await verifyTelnyxSignature(body, null, timestamp, publicKey)).toBe(false);
    expect(await verifyTelnyxSignature(body, signature, null, publicKey)).toBe(false);
    expect(await verifyTelnyxSignature(body, 'not base64 !!', timestamp, publicKey)).toBe(false);
    expect(await verifyTelnyxSignature(body, signature, timestamp, '')).toBe(false);
  });
});
