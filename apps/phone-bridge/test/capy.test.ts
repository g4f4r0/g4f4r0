import { describe, expect, it } from 'vitest';
import { createCapy, parseFrames } from '../src/capy';
import { parseConfig, type Env } from '../src/config';

const cfg = parseConfig({ CALLER_PHONE_NUMBER: '+1', TELNYX_PHONE_NUMBER: '+2', TELNYX_CONNECTION_ID: 'c', CAPY_PROJECT_ID: 'project_p', CAPY_CAPTAIN_ID: 'jam_axo' } as Env);

describe('capy send', () => {
  it('retries once with the same client key when Capy answers 5xx', async () => {
    const bodies: string[] = [];
    let n = 0;
    const fetcher = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return ++n === 1 ? new Response('busy', { status: 503 }) : Response.json({ id: 'msg1' });
    }) as unknown as typeof fetch;
    expect(await createCapy('k', cfg, fetcher).send('jam_t', 'hi', 'phone-1-1')).toBe('msg1');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0]).clientKey).toBe('phone-1-1');
  });

  it('retries when the first request stalls or fails on the network', async () => {
    let n = 0;
    const fetcher = (async () => {
      if (++n === 1) throw new DOMException('timed out', 'TimeoutError');
      return Response.json({ id: 'msg2' });
    }) as unknown as typeof fetch;
    expect(await createCapy('k', cfg, fetcher).send('jam_t', 'hi', 'phone-1-2')).toBe('msg2');
    expect(n).toBe(2);
  });
});

describe('capy call thread', () => {
  it('creates a small crew thread under the Captain on the call model', async () => {
    const calls: { url: string; body: any }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ id: 'jam_new' });
    }) as unknown as typeof fetch;
    const capy = createCapy('k', cfg, fetcher);
    expect(await capy.createThread('start', 'phone-1-1', 'Phone call from Johan')).toBe('jam_new');
    expect(calls[0].url).toBe('https://api.capy.ai/api/v1/threads');
    expect(calls[0].body).toEqual({
      requestId: 'phone-1-1',
      projectId: 'project_p',
      captainId: 'jam_axo',
      title: 'Phone call from Johan',
      message: 'start',
      model: { modelId: 'anthropic/claude-sonnet-5-5', reasoningMode: 'low' },
      machineSize: 'small',
    });
    await capy.archive('jam_new');
    expect(calls[1].url).toBe('https://api.capy.ai/api/v1/threads/jam_new/archive');
  });
});

describe('capy stream', () => {
  const sse = (frames: string) =>
    (async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frames)); } }), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;

  it('collects live fragments, tool calls and committed replies', async () => {
    const frames = [
      'event: status\ndata: {"status":"working"}',
      'event: assistant\ndata: {"callId":"c1","text":"Sure, "}',
      'event: assistant\ndata: {"callId":"c1","text":"checking."}',
      'event: tool_call\ndata: {"callId":"t1","name":"bash","text":"x"}',
      'id: 01CUR\nevent: transcript\ndata: {"id":"m1","source":"assistant","text":"Sure, checking.","callId":"c1"}',
      'event: status\ndata: {"status":"idle"}',
      '',
    ].join('\n\n');
    const w = await createCapy('k', cfg, sse(frames)).readReplies('jam_t', '01AFTER', 2000);
    expect(w.live).toEqual([{ callId: 'c1', text: 'Sure, checking.' }]);
    expect(w.toolStarted).toBe(true);
    expect(w.items.map(i => i.text)).toEqual(['Sure, checking.']);
    expect(w.cursor).toBe('01CUR');
    expect(w.worked).toBe(true);
    expect(w.status).toBe('idle');
  });

  it('parses frames split across chunks', () => {
    const { frames, rest } = parseFrames('event: a\ndata: 1\n\nevent: b\nda');
    expect(frames).toEqual([{ event: 'a', data: '1' }]);
    expect(rest).toBe('event: b\nda');
  });
});
