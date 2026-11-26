import { beforeEach, describe, expect, it } from 'vitest';
import { Bridge, type CallState, type Store } from '../src/engine';
import { parseConfig, type Env } from '../src/config';
import { encodeState } from '../src/telnyx';
import type { CapyMessage } from '../src/capy';

const ALLOWED = '+13072007045';
const REAL_ID = 'v3:ie0odK7cm5dCtztjy7_cbP30iOz-ruWD1g8xOEegMCBlZhv9DwtKqg';

function setup(overrides: Partial<Env> = {}) {
  const calls = new Map<string, CallState>();
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  const store: Store = {
    count: d => counts.get(d) ?? 0,
    increment: d => void counts.set(d, (counts.get(d) ?? 0) + 1),
    getCall: id => structuredClone(calls.get(id)),
    putCall: s => void calls.set(s.id, structuredClone(s)),
    deleteCall: id => void calls.delete(id),
    listCalls: () => [...calls.values()].map(c => structuredClone(c)),
    markSeen: id => (seen.has(id) ? false : (seen.add(id), true)),
  };
  const log: string[] = [];
  const sent: { text: string; key: string; delivery: string }[] = [];
  const axo = { queue: [] as CapyMessage[], status: 'working' };
  const clock = { now: Date.UTC(2026, 10, 26, 18, 0) };
  const env = { ALLOWED_CALLER: ALLOWED, TELNYX_NUMBER: '+13072070207', TELNYX_CONNECTION_ID: 'c', CAPY_THREAD_ID: 'jam_x', ...overrides } as Env;
  const cfg = parseConfig(env);
  let m = 0;
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
      stopSpeaking: async id => void log.push(`stop ${id}`),
      startTranscription: async id => void log.push(`stt ${id}`),
      hangup: async id => void log.push(`hangup ${id}`),
      dial: async s => (log.push(`dial ${JSON.stringify(s)}`), 'out-1'),
    },
    capy: {
      send: async (text, key, delivery = 'interrupt') => (sent.push({ text, key, delivery }), `01MSG${String(++m).padStart(21, '0')}`),
      readReplies: async afterId => ({ items: axo.queue.splice(0), cursor: afterId, status: axo.status }),
    },
  });
  let n = 0;
  const evt = (type: string, payload: Record<string, unknown>) =>
    bridge.handleEvent({ data: { event_type: type, id: `e${++n}`, payload } });
  const tick = async (ms = 0) => {
    clock.now += ms;
    await bridge.tick();
  };
  const reply = (text: string, status = 'idle') => {
    axo.queue.push({ id: `a${++m}`, source: 'assistant', text });
    axo.status = status;
  };
  const working = () => void (axo.status = 'working');
  const spoke = async (id = 'c1') => {
    await evt('call.speak.ended', { call_control_id: id });
    clock.now += 2000;
  };
  const hear = (text: string, id = 'c1') =>
    evt('call.transcription', { call_control_id: id, transcription_data: { is_final: true, transcript: text } });
  const say = async (text: string, id = 'c1') => {
    await spoke(id);
    working();
    await hear(text, id);
    await tick(1000);
  };
  const ring = async (id = 'c1') => {
    await evt('call.initiated', { call_control_id: id, direction: 'incoming', from: ALLOWED });
  };
  const pickUp = async (id = 'c1') => {
    await ring(id);
    reply('Hey Johan, what is up?');
    await tick();
    await evt('call.answered', { call_control_id: id, from: ALLOWED, client_state: encodeState({ k: 'in' }) });
  };
  const spoken = () => log.filter(l => l.startsWith('speak')).map(l => l.replace(/^speak \S+ /, ''));
  return { bridge, store, log, sent, axo, clock, evt, tick, reply, working, spoke, hear, say, ring, pickUp, spoken, cfg };
}

type S = ReturnType<typeof setup>;

describe('inbound: picking up', () => {
  let s: S;
  beforeEach(() => void (s = setup()));

  it('rejects any other number without answering or reaching Axo', async () => {
    await s.evt('call.initiated', { call_control_id: 'x1', direction: 'incoming', from: '+34600999888' });
    await s.evt('call.initiated', { call_control_id: 'x2', direction: 'incoming', from: 'anonymous' });
    expect(s.log).toEqual(['reject x1', 'reject x2']);
    expect(s.sent).toEqual([]);
  });

  it('tells Axo who is calling and when, and keeps ringing until the greeting is ready', async () => {
    await s.ring();
    expect(s.sent).toHaveLength(1);
    const start = s.sent[0].text;
    expect(start).toMatch(/^<phone_call event="start" direction="inbound" caller="Johan" time="Thu, 26 Nov 2026, 19:00 \(Europe\/Madrid\)">/);
    expect(start).toContain('greeting by name');
    expect(start).toContain('Never mention the phone bridge');
    expect(s.log).toEqual([]);
    s.reply('Hey Johan, what is up?');
    await s.tick();
    expect(s.log).toEqual(['answer c1 {"k":"in"}']);
    await s.evt('call.answered', { call_control_id: 'c1', from: ALLOWED, client_state: encodeState({ k: 'in' }) });
    expect(s.spoken()).toEqual(['Hey Johan, what is up?']);
    expect(s.log).toContain('stt c1');
  });

  it('answers with a short greeting if Axo is slow, then speaks Axo when it arrives', async () => {
    await s.ring();
    await s.tick(7000);
    expect(s.log).toEqual([]);
    await s.tick(1000);
    expect(s.log).toEqual(['answer c1 {"k":"in"}']);
    await s.evt('call.answered', { call_control_id: 'c1', from: ALLOWED, client_state: encodeState({ k: 'in' }) });
    expect(s.spoken()).toEqual(['Hey Johan.']);
    s.reply('Hey Johan!');
    await s.tick(1000);
    expect(s.spoken()).toEqual(['Hey Johan.', 'Hey Johan!']);
  });

  it('hangs up an answered leg whose caller is not the allowed number', async () => {
    await s.evt('call.answered', { call_control_id: 'c9', from: '+34600999888', client_state: encodeState({ k: 'in' }) });
    expect(s.log).toEqual(['hangup c9']);
  });

  it('ignores answered legs it did not start', async () => {
    await s.evt('call.answered', { call_control_id: 'c9', from: ALLOWED });
    expect(s.log).toEqual([]);
  });

  it('processes a repeated webhook delivery once', async () => {
    const e = { data: { event_type: 'call.initiated', id: 'same', payload: { call_control_id: 'd1', direction: 'incoming', from: ALLOWED } } };
    await s.bridge.handleEvent(e);
    await s.bridge.handleEvent(e);
    expect(s.sent).toHaveLength(1);
  });
});

describe('inbound: conversation', () => {
  let s: S;
  beforeEach(async () => {
    s = setup();
    await s.pickUp();
  });

  it('sends his words as a short tagged turn and speaks every reply message in order', async () => {
    await s.say('what is on my calendar');
    expect(s.sent[1]).toMatchObject({ text: '[phone call] what is on my calendar', delivery: 'interrupt' });
    s.reply('You have two meetings.', 'working');
    s.reply('The first is at **ten**.', 'idle');
    await s.tick();
    expect(s.spoken().slice(1)).toEqual(['You have two meetings.', 'The first is at ten.']);
    expect(s.store.getCall('c1')?.waiting).toBeNull();
  });

  it('keeps waiting while Axo is still working after its first message', async () => {
    await s.say('status');
    s.reply('Checking.', 'working');
    await s.tick();
    expect(s.store.getCall('c1')?.waiting).not.toBeNull();
    s.reply('All green.');
    await s.tick();
    expect(s.spoken().slice(-2)).toEqual(['Checking.', 'All green.']);
    expect(s.store.getCall('c1')?.waiting).toBeNull();
  });

  it('joins split utterances into one turn', async () => {
    await s.spoke();
    await s.hear('check my');
    s.clock.now += 300;
    await s.hear('calendar');
    await s.tick(1000);
    expect(s.sent[1].text).toBe('[phone call] check my calendar');
  });

  it('sends a new utterance right away even while Axo is still thinking', async () => {
    await s.say('first question');
    await s.hear('actually never mind');
    await s.tick(1000);
    expect(s.sent.map(x => x.text).slice(1)).toEqual(['[phone call] first question', '[phone call] actually never mind']);
  });

  it('stops speaking and passes his words on when he talks over Axo', async () => {
    await s.say('tell me everything');
    s.reply('Here is a long story about the deploy and the database migration.');
    await s.tick();
    await s.hear('stop stop, just the summary');
    expect(s.log).toContain('stop c1');
    await s.tick(1000);
    expect(s.sent.at(-1)).toMatchObject({ text: '[phone call] stop stop, just the summary', delivery: 'interrupt' });
  });

  it('drops the rest of the cut-off reply and keeps hearing him after a barge-in', async () => {
    await s.say('tell me everything');
    s.reply('Here is a long story about the deploy and the database migration.', 'working');
    await s.tick();
    await s.hear('wait a second');
    await s.evt('call.speak.ended', { call_control_id: 'c1' });
    s.reply('And then the migration ran for hours.', 'working');
    await s.tick();
    s.clock.now += 300;
    await s.hear('what broke');
    await s.tick(1000);
    expect(s.spoken()).not.toContain('And then the migration ran for hours.');
    expect(s.sent.at(-1)?.text).toBe('[phone call] wait a second what broke');
  });

  it('ignores its own voice while speaking and right after', async () => {
    await s.hear('Hey Johan what is up');
    await s.hear('okay');
    await s.evt('call.speak.ended', { call_control_id: 'c1' });
    s.clock.now += 500;
    await s.hear('anything at all');
    await s.tick(5000);
    expect(s.sent).toHaveLength(1);
    expect(s.log).not.toContain('stop c1');
  });

  it('drops a late echo of its own holding phrase but keeps real speech', async () => {
    await s.say('long question');
    await s.tick(7000);
    expect(s.spoken()).toContain('One moment.');
    await s.spoke();
    await s.hear('1 moment.');
    await s.hear('One moments');
    await s.tick(1000);
    expect(s.sent).toHaveLength(2);
    await s.say('thanks, retry the deploy');
    expect(s.sent.at(-1)?.text).toBe('[phone call] thanks, retry the deploy');
  });

  it('keeps listening if a speak.ended event never arrives', async () => {
    s.clock.now += 61_000;
    await s.hear('are you there');
    await s.tick(1000);
    expect(s.sent.at(-1)?.text).toBe('[phone call] are you there');
  });

  it('stops waiting quietly when Axo ends its turn without a message', async () => {
    await s.say('thanks');
    s.axo.status = 'idle';
    await s.tick(3000);
    expect(s.store.getCall('c1')?.waiting).not.toBeNull();
    await s.tick(4000);
    expect(s.store.getCall('c1')?.waiting).toBeNull();
    expect(s.spoken()).not.toContain('Something went wrong on my side. Please try again later. Goodbye.');
  });

  it('gives up after the reply timeout and says so', async () => {
    await s.say('long question');
    await s.tick(181_000);
    expect(s.spoken().some(t => t.includes('has not answered yet'))).toBe(true);
  });

  it('uses a Capy client key within the 64 character limit for real Telnyx call ids', async () => {
    const r = setup();
    await r.pickUp(REAL_ID);
    await r.say('first', REAL_ID);
    await r.say('second', REAL_ID);
    expect(new Set(r.sent.map(x => x.key)).size).toBe(3);
    for (const x of r.sent) expect(x.key.length).toBeLessThanOrEqual(64);
  });
});

describe('inbound: silence and hang up', () => {
  let s: S;
  beforeEach(async () => {
    s = setup();
    await s.pickUp();
    await s.spoke();
    s.axo.status = 'idle';
    await s.tick();
  });

  it('asks Axo to check in after 20 seconds of silence, then to say goodbye, then hangs up', async () => {
    await s.tick(17_000);
    expect(s.sent).toHaveLength(1);
    await s.tick(1_500);
    expect(s.sent[1].text).toMatch(/^<phone_call event="silence" seconds="2\d">Check in/);
    s.reply('Anything else?');
    await s.tick();
    await s.spoke();
    await s.tick(20_000);
    expect(s.sent[2].text).toContain('goodbye');
    s.reply('Talk later, Johan.');
    await s.tick();
    expect(s.log).not.toContain('hangup c1');
    await s.evt('call.speak.ended', { call_control_id: 'c1' });
    expect(s.log).toContain('hangup c1');
  });

  it('resets the silence counter when he speaks', async () => {
    await s.tick(21_000);
    s.reply('Anything else?');
    await s.tick();
    await s.say('yes, one thing');
    expect(s.store.getCall('c1')?.idlePrompts).toBe(0);
  });

  it('records the end of the call in the thread without interrupting Axo', async () => {
    s.clock.now += 72_000;
    await s.evt('call.hangup', { call_control_id: 'c1', hangup_source: 'caller' });
    expect(s.sent.at(-1)?.delivery).toBe('queue');
    expect(s.sent.at(-1)?.text).toMatch(/^<phone_call event="end" duration="1m 1\ds" ended_by="Johan" turns="1">/);
    expect(s.store.getCall('c1')).toBeUndefined();
  });

  it('ends the call at the length cap and hangs up', async () => {
    await s.tick(s.cfg.maxCallMs);
    expect(s.log.some(l => l.includes('time limit') && l.includes('"end":true'))).toBe(true);
    await s.evt('call.speak.ended', { call_control_id: 'c1', client_state: encodeState({ end: true }) });
    expect(s.log).toContain('hangup c1');
  });

  it('force hangs up if the goodbye never finishes', async () => {
    await s.tick(s.cfg.maxCallMs);
    await s.tick(11_000);
    expect(s.log).toContain('hangup c1');
    expect(s.store.getCall('c1')).toBeUndefined();
  });
});

describe('config', () => {
  it('uses the configured call length', async () => {
    const s = setup({ MAX_CALL_SECONDS: '30' });
    await s.pickUp();
    await s.tick(20_000);
    expect(s.spoken().some(t => t.includes('time limit'))).toBe(false);
    await s.tick(11_000);
    expect(s.spoken().some(t => t.includes('time limit'))).toBe(true);
  });

  it('speaks and asks for Spanish when configured', async () => {
    const s = setup({ LANGUAGE: 'es' });
    await s.ring();
    expect(s.sent[0].text).toContain('spoken to him in Spanish');
    await s.tick(8000);
    await s.evt('call.answered', { call_control_id: 'c1', from: ALLOWED, client_state: encodeState({ k: 'in' }) });
    expect(s.spoken()).toEqual(['Hola Johan.']);
  });
});

describe('outbound calls', () => {
  it('dials, speaks the alert and hangs up when no reply is wanted, without writing to the thread', async () => {
    const s = setup();
    expect(await s.bridge.placeOutbound('Build failed', false)).toEqual({ ok: true, callControlId: 'out-1' });
    await s.evt('call.answered', { call_control_id: 'o1', to: ALLOWED, client_state: encodeState({ k: 'out', text: 'Build failed', listen: false }) });
    expect(s.log).toContain('speak o1 Build failed {"end":true}');
    expect(s.log).not.toContain('stt o1');
    await s.evt('call.hangup', { call_control_id: 'o1' });
    expect(s.sent).toEqual([]);
  });

  it('listens and sends his answer with the alert as context', async () => {
    const s = setup();
    await s.evt('call.answered', { call_control_id: 'o1', to: ALLOWED, client_state: encodeState({ k: 'out', text: 'Build failed', listen: true }) });
    expect(s.log).toContain('stt o1');
    await s.say('retry it', 'o1');
    expect(s.sent[0].text).toMatch(/^<phone_call event="start" direction="outbound"/);
    expect(s.sent[0].text).toContain('You phoned Johan to tell him: "Build failed"');
    expect(s.sent[0].text).toMatch(/\n\[phone call\] retry it$/);
  });

  it('enforces the daily cap and never dials past it', async () => {
    const s = setup({ MAX_OUTBOUND_PER_DAY: '3' });
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await s.bridge.placeOutbound('hi', false)).ok);
    expect(results).toEqual([true, true, true, false, false]);
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
