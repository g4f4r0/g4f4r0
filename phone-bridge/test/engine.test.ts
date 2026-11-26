import { beforeEach, describe, expect, it } from 'vitest';
import { Bridge, type CallState, type Store } from '../src/engine';
import { parseConfig, type Env } from '../src/config';
import { encodeState } from '../src/telnyx';
import type { CapyMessage } from '../src/capy';

const ALLOWED = '+34600111222';

function setup(overrides: Partial<Env> = {}) {
  const calls = new Map<string, CallState>();
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  const store: Store = {
    count: d => counts.get(d) ?? 0,
    increment: d => void counts.set(d, (counts.get(d) ?? 0) + 1),
    getCall: id => calls.get(id),
    putCall: s => void calls.set(s.id, structuredClone(s)),
    deleteCall: id => void calls.delete(id),
    listCalls: () => [...calls.values()].map(c => structuredClone(c)),
    markSeen: id => (seen.has(id) ? false : (seen.add(id), true)),
  };
  const log: string[] = [];
  const reply = { items: [] as CapyMessage[], cursor: null as string | null, status: 'idle' };
  const clock = { now: 1_000_000 };
  const env = {
    ALLOWED_CALLER: ALLOWED,
    TELNYX_NUMBER: '+34900000000',
    TELNYX_CONNECTION_ID: 'conn1',
    CAPY_THREAD_ID: 'jam_x',
    ...overrides,
  } as Env;
  const cfg = parseConfig(env);
  const sent: string[] = [];
  const keys: string[] = [];
  const bridge = new Bridge({
    cfg,
    store,
    now: () => clock.now,
    setAlarm: async () => undefined,
    log: () => undefined,
    telnyx: {
      answer: async (id, s) => void log.push(`answer ${id} ${JSON.stringify(s)}`),
      reject: async id => void log.push(`reject ${id}`),
      speak: async (id, t, s) => void log.push(`speak ${id} ${t}${s ? ' ' + JSON.stringify(s) : ''}`),
      startTranscription: async id => void log.push(`stt ${id}`),
      hangup: async id => void log.push(`hangup ${id}`),
      dial: async s => (log.push(`dial ${JSON.stringify(s)}`), 'out-call-1'),
    },
    capy: {
      send: async (text, clientKey) => (sent.push(text), keys.push(clientKey), '01SENTMESSAGEID00000000000A'),
      listAfter: async () => ({ items: reply.items, cursor: reply.cursor }),
      status: async () => reply.status,
    },
  });
  let n = 0;
  const evt = (type: string, payload: Record<string, unknown>) =>
    bridge.handleEvent({ data: { event_type: type, id: `e${++n}`, payload } });
  return { bridge, store, log, sent, keys, reply, clock, evt, cfg };
}

const answerInbound = async (s: ReturnType<typeof setup>) => {
  await s.evt('call.initiated', { call_control_id: 'c1', direction: 'incoming', from: ALLOWED });
  await s.evt('call.answered', { call_control_id: 'c1', from: ALLOWED, client_state: encodeState({ k: 'in' }) });
};
const spoke = async (s: ReturnType<typeof setup>, id = 'c1') => {
  await s.evt('call.speak.ended', { call_control_id: id });
  s.clock.now += 2000;
};
const say = async (s: ReturnType<typeof setup>, text: string) => {
  await spoke(s);
  await s.evt('call.transcription', { call_control_id: 'c1', transcription_data: { is_final: true, transcript: text } });
  s.clock.now += 2000;
  await s.bridge.tick();
};

describe('inbound calls', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => void (s = setup()));

  it('rejects a call from any other number without answering or reaching Axo', async () => {
    await s.evt('call.initiated', { call_control_id: 'x1', direction: 'incoming', from: '+34600999888' });
    await s.evt('call.initiated', { call_control_id: 'x2', direction: 'incoming', from: 'anonymous' });
    expect(s.log).toEqual(['reject x1', 'reject x2']);
    expect(s.sent).toEqual([]);
  });

  it('answers the allowed number, greets and starts listening', async () => {
    await answerInbound(s);
    expect(s.log[0]).toContain('answer c1');
    expect(s.log).toContain('speak c1 Axo here. Go ahead.');
    expect(s.log).toContain('stt c1');
  });

  it('hangs up an answered leg whose caller is not the allowed number', async () => {
    await s.evt('call.answered', { call_control_id: 'c9', from: '+34600999888', client_state: encodeState({ k: 'in' }) });
    expect(s.log).toEqual(['hangup c9']);
    expect(s.store.getCall('c9')).toBeUndefined();
  });

  it('ignores answered legs it did not start', async () => {
    await s.evt('call.answered', { call_control_id: 'c9', from: ALLOWED });
    expect(s.log).toEqual([]);
  });

  it('sends what he said to Axo and speaks the reply', async () => {
    await answerInbound(s);
    await say(s, 'what is on my calendar');
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain('[phone call]');
    expect(s.sent[0]).toContain('What he said: what is on my calendar');
    s.reply.items = [{ id: 'a1', source: 'assistant', text: 'You have **two** meetings.' }];
    s.reply.cursor = '01CURSOR000000000000000001';
    s.clock.now += 2000;
    await s.bridge.tick();
    expect(s.log).toContain('speak c1 You have two meetings.');
    expect(s.store.getCall('c1')?.waiting).toBeNull();
  });

  it('uses a Capy client key within the 64 character limit for real Telnyx call ids', async () => {
    const id = 'v3:ie0odK7cm5dCtztjy7_cbP30iOz-ruWD1g8xOEegMCBlZhv9DwtKqg';
    await s.evt('call.answered', { call_control_id: id, from: ALLOWED, client_state: encodeState({ k: 'in' }) });
    for (const turn of ['first', 'second']) {
      await spoke(s, id);
      await s.evt('call.transcription', { call_control_id: id, transcription_data: { is_final: true, transcript: turn } });
      s.clock.now += 2000;
      await s.bridge.tick();
      s.reply.items = [{ id: turn, source: 'assistant', text: 'ok' }];
      s.clock.now += 2000;
      await s.bridge.tick();
    }
    expect(s.keys).toHaveLength(2);
    expect(new Set(s.keys).size).toBe(2);
    for (const k of s.keys) expect(k.length).toBeLessThanOrEqual(64);
  });

  it('sends the follow-up turn without repeating the instructions', async () => {
    await answerInbound(s);
    await say(s, 'first');
    s.reply.items = [{ id: 'a1', source: 'assistant', text: 'ok' }];
    s.clock.now += 2000;
    await s.bridge.tick();
    await say(s, 'second');
    expect(s.sent[1]).toBe('[phone call] second');
  });

  it('joins split utterances into one message', async () => {
    await answerInbound(s);
    await spoke(s);
    await s.evt('call.transcription', { call_control_id: 'c1', transcription_data: { is_final: true, transcript: 'check my' } });
    s.clock.now += 500;
    await s.evt('call.transcription', { call_control_id: 'c1', transcription_data: { is_final: true, transcript: 'calendar' } });
    s.clock.now += 2000;
    await s.bridge.tick();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain('check my calendar');
  });

  it('ignores what it hears while it is speaking', async () => {
    await answerInbound(s);
    await s.evt('call.transcription', { call_control_id: 'c1', transcription_data: { is_final: true, transcript: 'Axo here go ahead' } });
    s.clock.now += 5000;
    await s.bridge.tick();
    expect(s.sent).toEqual([]);
  });

  it('ignores an echo that arrives just after it stopped speaking', async () => {
    await answerInbound(s);
    await s.evt('call.speak.ended', { call_control_id: 'c1' });
    s.clock.now += 500;
    await s.evt('call.transcription', { call_control_id: 'c1', transcription_data: { is_final: true, transcript: 'anything' } });
    s.clock.now += 5000;
    await s.bridge.tick();
    expect(s.sent).toEqual([]);
  });

  it('drops a late transcript of its own holding phrase but keeps real speech', async () => {
    await answerInbound(s);
    await say(s, 'long question');
    s.clock.now += 9000;
    await s.bridge.tick();
    expect(s.log.some(l => l.includes('One moment, I am asking Axo.'))).toBe(true);
    await spoke(s);
    await s.evt('call.transcription', { call_control_id: 'c1', transcription_data: { is_final: true, transcript: 'I am asking Axos' } });
    await s.evt('call.transcription', { call_control_id: 'c1', transcription_data: { is_final: true, transcript: '1 moment.' } });
    s.reply.items = [{ id: 'a1', source: 'assistant', text: 'Here is the answer.' }];
    s.clock.now += 2000;
    await s.bridge.tick();
    await say(s, 'thanks, retry the deploy');
    expect(s.sent).toEqual([expect.stringContaining('long question'), '[phone call] thanks, retry the deploy']);
  });

  it('keeps listening if a speak.ended event never arrives', async () => {
    await answerInbound(s);
    s.clock.now += 61_000;
    await s.evt('call.transcription', { call_control_id: 'c1', transcription_data: { is_final: true, transcript: 'are you there' } });
    s.clock.now += 2000;
    await s.bridge.tick();
    expect(s.sent).toHaveLength(1);
  });

  it('ignores interim transcripts and empty ones', async () => {
    await answerInbound(s);
    await s.evt('call.transcription', { call_control_id: 'c1', transcription_data: { is_final: false, transcript: 'hel' } });
    await s.evt('call.transcription', { call_control_id: 'c1', transcription_data: { is_final: true, transcript: '  ' } });
    s.clock.now += 5000;
    await s.bridge.tick();
    expect(s.sent).toEqual([]);
  });

  it('speaks a holding phrase when Axo is slow, then keeps waiting', async () => {
    await answerInbound(s);
    await say(s, 'long question');
    s.clock.now += 9000;
    await s.bridge.tick();
    expect(s.log.filter(l => l.includes('One moment'))).toHaveLength(1);
    s.clock.now += 2000;
    await s.bridge.tick();
    expect(s.log.filter(l => l.includes('One moment'))).toHaveLength(1);
    expect(s.store.getCall('c1')?.waiting).not.toBeNull();
  });

  it('gives up after the reply timeout and says so', async () => {
    await answerInbound(s);
    await say(s, 'long question');
    s.clock.now += 181_000;
    await s.bridge.tick();
    expect(s.log.some(l => l.includes('Axo has not answered yet'))).toBe(true);
  });

  it('ends the call at the length cap and hangs up', async () => {
    await answerInbound(s);
    s.clock.now += s.cfg.maxCallMs;
    await s.bridge.tick();
    expect(s.log.some(l => l.includes('time limit') && l.includes('"end":true'))).toBe(true);
    await s.evt('call.speak.ended', { call_control_id: 'c1', client_state: encodeState({ end: true }) });
    expect(s.log).toContain('hangup c1');
  });

  it('force hangs up if the goodbye never finishes', async () => {
    await answerInbound(s);
    s.clock.now += s.cfg.maxCallMs;
    await s.bridge.tick();
    s.clock.now += 11_000;
    await s.bridge.tick();
    expect(s.log).toContain('hangup c1');
    expect(s.store.getCall('c1')).toBeUndefined();
  });

  it('uses the configured call length', async () => {
    const short = setup({ MAX_CALL_SECONDS: '30' });
    await answerInbound(short);
    short.clock.now += 29_000;
    await short.bridge.tick();
    expect(short.log.some(l => l.includes('time limit'))).toBe(false);
    short.clock.now += 2_000;
    await short.bridge.tick();
    expect(short.log.some(l => l.includes('time limit'))).toBe(true);
  });

  it('processes a repeated webhook delivery once', async () => {
    const evt = { data: { event_type: 'call.initiated', id: 'same', payload: { call_control_id: 'd1', direction: 'incoming', from: ALLOWED } } };
    await s.bridge.handleEvent(evt);
    await s.bridge.handleEvent(evt);
    expect(s.log.filter(l => l.startsWith('answer'))).toHaveLength(1);
  });

  it('cleans up on hangup', async () => {
    await answerInbound(s);
    await s.evt('call.hangup', { call_control_id: 'c1' });
    expect(s.store.getCall('c1')).toBeUndefined();
  });

  it('speaks Spanish when configured', async () => {
    const es = setup({ LANGUAGE: 'es' });
    await answerInbound(es);
    expect(es.log).toContain('speak c1 Habla Axo. Dime.');
    await say(es, 'hola');
    expect(es.sent[0]).toContain('answer in Spanish');
  });
});

describe('outbound calls', () => {
  it('dials the allowed number and speaks the alert, then hangs up when no reply is wanted', async () => {
    const s = setup();
    const r = await s.bridge.placeOutbound('Build failed', false);
    expect(r).toEqual({ ok: true, callControlId: 'out-call-1' });
    await s.evt('call.answered', { call_control_id: 'o1', to: ALLOWED, client_state: encodeState({ k: 'out', text: 'Build failed', listen: false }) });
    expect(s.log).toContain('speak o1 Build failed {"end":true}');
    expect(s.log).not.toContain('stt o1');
  });

  it('listens and relays the answer with the alert as context when asked to', async () => {
    const s = setup();
    await s.evt('call.answered', { call_control_id: 'o1', to: ALLOWED, client_state: encodeState({ k: 'out', text: 'Build failed', listen: true }) });
    expect(s.log).toContain('stt o1');
    await spoke(s, 'o1');
    await s.evt('call.transcription', { call_control_id: 'o1', transcription_data: { is_final: true, transcript: 'retry it' } });
    s.clock.now += 2000;
    await s.bridge.tick();
    expect(s.sent[0]).toContain('You phoned him to tell him: "Build failed"');
    expect(s.sent[0]).toContain('retry it');
  });

  it('enforces the daily cap and never dials past it', async () => {
    const s = setup({ MAX_OUTBOUND_PER_DAY: '3' });
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await s.bridge.placeOutbound('hi', false));
    expect(results.map(r => r.ok)).toEqual([true, true, true, false, false]);
    expect(s.log.filter(l => l.startsWith('dial'))).toHaveLength(3);
  });

  it('defaults to 10 outbound calls per day', async () => {
    const s = setup();
    const results = [];
    for (let i = 0; i < 11; i++) results.push((await s.bridge.placeOutbound('hi', false)).ok);
    expect(results.filter(Boolean)).toHaveLength(10);
  });

  it('refuses an outbound answered leg that is not the allowed number', async () => {
    const s = setup();
    await s.evt('call.answered', { call_control_id: 'o2', to: '+34600999888', client_state: encodeState({ k: 'out', text: 'x', listen: false }) });
    expect(s.log).toEqual(['hangup o2']);
  });
});
