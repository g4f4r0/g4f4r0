import { describe, expect, it } from 'vitest';
import { createCapy, parseFrames } from '../src/capy';
import { parseConfig, type Env } from '../src/config';

const cfg = parseConfig({ CALLER_PHONE_NUMBER: '+1', TELNYX_PHONE_NUMBER: '+2', TELNYX_CONNECTION_ID: 'c', CAPY_THREAD_ID: 'jam_t' } as Env);

describe('capy send', () => {
  it('retries once with the same client key when Capy answers 5xx', async () => {
    const bodies: string[] = [];
    let n = 0;
    const fetcher = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return ++n === 1 ? new Response('busy', { status: 503 }) : Response.json({ id: 'msg1' });
    }) as unknown as typeof fetch;
    expect(await createCapy('k', cfg, fetcher).send('hi', 'phone-1-1')).toBe('msg1');
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
    expect(await createCapy('k', cfg, fetcher).send('hi', 'phone-1-2')).toBe('msg2');
    expect(n).toBe(2);
  });
});

describe('capy model selection', () => {
  it('sends the model selection and falls back to a plain send if Capy rejects it', async () => {
    const bodies: any[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      bodies.push(b);
      return b.model ? new Response('{"code":"ModelSelection.Rejected"}', { status: 400 }) : Response.json({ id: 'msg3' });
    }) as unknown as typeof fetch;
    const id = await createCapy('k', cfg, fetcher).send('hi', 'phone-1-3', 'interrupt', { modelId: 'x/y', reasoningMode: 'low' });
    expect(id).toBe('msg3');
    expect(bodies.map(b => b.model?.reasoningMode ?? null)).toEqual(['low', null]);
  });

  it('reads the thread model and which models offer fast mode', async () => {
    const fetcher = (async (url: string) =>
      url.endsWith('/models')
        ? Response.json({ items: [{ id: 'anthropic/claude-opus-5-5', fast: true }, { id: 'anthropic/claude-sonnet-5-5', fast: false }] })
        : Response.json({ id: 'jam_t', lastModelId: 'anthropic/claude-opus-5-5' })) as unknown as typeof fetch;
    expect(await createCapy('k', cfg, fetcher).readModels()).toEqual({ current: 'anthropic/claude-opus-5-5', fast: ['anthropic/claude-opus-5-5'] });
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
    const w = await createCapy('k', cfg, sse(frames)).readReplies('01AFTER', 2000);
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
