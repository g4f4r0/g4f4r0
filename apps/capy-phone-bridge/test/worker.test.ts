import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/config';
import { makeKeys, signWith } from './helpers';

async function makeEnv() {
  const keys = await makeKeys();
  const forwarded: { url: string; body: string }[] = [];
  const env = {
    TELNYX_PUBLIC_KEY: keys.publicKey,
    OUTBOUND_TOKEN: 'tok-123',
    BRIDGE: {
      idFromName: () => 'id',
      get: () => ({
        fetch: async (url: string, init: RequestInit) => {
          forwarded.push({ url, body: String(init.body) });
          return new Response('{}', { status: 202 });
        },
      }),
    },
  } as unknown as Env;
  return { env, keys, forwarded };
}

const call = (headers: Record<string, string>, body: unknown) =>
  new Request('https://x.dev/call', { method: 'POST', headers, body: JSON.stringify(body) });

describe('POST /call', () => {
  it('returns 401 and places no call without the token', async () => {
    const { env, forwarded } = await makeEnv();
    expect((await worker.fetch(call({}, { text: 'hi' }), env)).status).toBe(401);
    expect((await worker.fetch(call({ authorization: 'Bearer wrong' }, { text: 'hi' }), env)).status).toBe(401);
    expect((await worker.fetch(call({ authorization: 'tok-123' }, { text: 'hi' }), env)).status).toBe(401);
    expect(forwarded).toEqual([]);
  });

  it('forwards a valid request', async () => {
    const { env, forwarded } = await makeEnv();
    const res = await worker.fetch(call({ authorization: 'Bearer tok-123' }, { text: ' Server down ', listen: true }), env);
    expect(res.status).toBe(202);
    expect(JSON.parse(forwarded[0].body)).toEqual({ text: 'Server down', listen: true });
  });

  it('forwards a callback thread and rejects anything that is not a thread id', async () => {
    const { env, forwarded } = await makeEnv();
    const auth = { authorization: 'Bearer tok-123' };
    expect((await worker.fetch(call(auth, { text: 'Back to you', listen: true, thread: 'jam_01M8ETT63B4N1FKT99PJCES5R1' }), env)).status).toBe(202);
    expect(JSON.parse(forwarded[0].body)).toEqual({ text: 'Back to you', listen: true, thread: 'jam_01M8ETT63B4N1FKT99PJCES5R1' });
    expect((await worker.fetch(call(auth, { text: 'x', thread: '../threads' }), env)).status).toBe(400);
    expect((await worker.fetch(call(auth, { text: 'x', thread: 7 }), env)).status).toBe(400);
    expect(forwarded).toHaveLength(1);
  });

  it('rejects empty or oversized text with 400', async () => {
    const { env, forwarded } = await makeEnv();
    expect((await worker.fetch(call({ authorization: 'Bearer tok-123' }, { text: '' }), env)).status).toBe(400);
    expect((await worker.fetch(call({ authorization: 'Bearer tok-123' }, { text: 'x'.repeat(1001) }), env)).status).toBe(400);
    expect(forwarded).toEqual([]);
  });
});

describe('POST /telnyx/webhook', () => {
  const body = JSON.stringify({ data: { event_type: 'call.initiated', id: 'e1', payload: { call_control_id: 'c1' } } });

  it('refuses a forged webhook and does not reach the bridge', async () => {
    const { env, forwarded } = await makeEnv();
    const forger = await makeKeys();
    const { signature, timestamp } = await signWith(forger.privateKey, body);
    const forged = new Request('https://x.dev/telnyx/webhook', {
      method: 'POST',
      headers: { 'telnyx-signature-ed25519': signature, 'telnyx-timestamp': timestamp },
      body,
    });
    expect((await worker.fetch(forged, env)).status).toBe(401);
    expect((await worker.fetch(new Request('https://x.dev/telnyx/webhook', { method: 'POST', body }), env)).status).toBe(401);
    expect(forwarded).toEqual([]);
  });

  it('passes a genuine webhook to the bridge untouched', async () => {
    const { env, keys, forwarded } = await makeEnv();
    const { signature, timestamp } = await signWith(keys.privateKey, body);
    const res = await worker.fetch(
      new Request('https://x.dev/telnyx/webhook', {
        method: 'POST',
        headers: { 'telnyx-signature-ed25519': signature, 'telnyx-timestamp': timestamp },
        body,
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(forwarded[0].body).toBe(body);
  });
});
