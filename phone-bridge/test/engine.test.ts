import { beforeEach, describe, expect, it } from 'vitest';
import { Bridge, type CallState, type Store } from '../src/engine';
import { parseConfig, type Env } from '../src/config';
import { encodeState } from '../src/telnyx';
import type { CapyMessage, ModelSelection } from '../src/capy';

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
  const sent: { text: string; key: string; delivery: string; model?: ModelSelection }[] = [];
  const axo = { queue: [] as CapyMessage[], status: 'working', worked: true, sendFails: 0, readFails: 0, models: { current: 'anthropic/claude-sonnet-5-5' as string | null, fast: ['anthropic/claude-opus-5-5'] }, live: [] as { callId: string; text: string }[], tool: false, stt: 'deepgram/nova-3' };
  const clock = { now: Date.UTC(2026, 10, 26, 18, 0) };
  const env = { CALLER_PHONE_NUMBER: ALLOWED, TELNYX_PHONE_NUMBER: '+13072070207', TELNYX_CONNECTION_ID: 'c', CAPY_THREAD_ID: 'jam_x', ...overrides } as Env;
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
      playMusic: async (id, url) => void log.push(`music ${id} ${url}`),
      startTranscription: async id => (log.push(`stt ${id}`), axo.stt),
      hangup: async id => void log.push(`hangup ${id}`),
      dial: async s => (log.push(`dial ${JSON.stringify(s)}`), 'out-1'),
    },
    capy: {
      readModels: async () => axo.models,
      send: async (text, key, delivery = 'interrupt', model) => {
        if (axo.sendFails > 0 && axo.sendFails--) throw new Error('capy down');
        sent.push({ text, key, delivery, model });
        return `01MSG${String(++m).padStart(21, '0')}`;
      },
      readReplies: async afterId => {
        if (axo.readFails > 0 && axo.readFails--) throw new Error('stream 503');
        const w = { items: axo.queue.splice(0), live: axo.live.splice(0), cursor: afterId, status: axo.status, worked: axo.worked, toolStarted: axo.tool };
        axo.tool = false;
        axo.worked = axo.status === 'working';
        return w;
      },
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
  const working = () => void ((axo.status = 'working'), (axo.worked = true));
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
    await tick(1200);
  };
  const ring = async (id = 'c1') => {
    await evt('call.initiated', { call_control_id: id, direction: 'incoming', from: ALLOWED });
    await tick();
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
    expect(start).toMatch(/^\[Channel: Phone call\] \[Event: Incoming call\] \[From: Johan\] \[Time: Thu, 26 Nov 2026, 19:00 Europe\/Madrid\] /);
    expect(start).toContain('greet him by name');
    expect(start).toContain('Never restate what he said');
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
    await s.tick(19_000);
    expect(s.log).toEqual([]);
    await s.tick(1200);
    expect(s.log).toEqual(['answer c1 {"k":"in"}']);
    await s.evt('call.answered', { call_control_id: 'c1', from: ALLOWED, client_state: encodeState({ k: 'in' }) });
    expect(s.spoken()).toEqual(['Hey Johan.']);
    s.reply('Hey Johan!');
    await s.tick(1200);
    expect(s.spoken()).toEqual(['Hey Johan.', 'Hey Johan!']);
  });

  it('keeps ringing while Axo is still waking up instead of giving up on the greeting', async () => {
    s.axo.status = 'waiting';
    s.axo.worked = false;
    await s.ring();
    for (let i = 0; i < 4; i++) await s.tick(2500);
    expect(s.log).toEqual([]);
    s.axo.status = 'working';
    s.axo.worked = true;
    await s.tick(500);
    s.reply('Hey Johan, good to hear you.');
    await s.tick(500);
    expect(s.log).toEqual(['answer c1 {"k":"in"}']);
    await s.evt('call.answered', { call_control_id: 'c1', from: ALLOWED, client_state: encodeState({ k: 'in' }) });
    expect(s.spoken()).toEqual(['Hey Johan, good to hear you.']);
  });

  it('answers with the fallback right away if Capy is down, and briefs Axo with his first words', async () => {
    s.axo.sendFails = 1;
    await s.ring();
    expect(s.log).toEqual(['answer c1 {"k":"in"}']);
    await s.evt('call.answered', { call_control_id: 'c1', from: ALLOWED, client_state: encodeState({ k: 'in' }) });
    expect(s.spoken()).toEqual(['Hey Johan.']);
    await s.say('are you there');
    expect(s.sent[0].text).toMatch(/^\[Channel: Phone call\] \[Event: Incoming call\] /);
    expect(s.sent[0].text).toMatch(/\n\[Channel: Phone call\] \[From: Johan\] are you there$/);
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
    await s.tick();
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
    expect(s.sent[1]).toMatchObject({ text: '[Channel: Phone call] [From: Johan] what is on my calendar', delivery: 'interrupt' });
    s.reply('You have two meetings.', 'working');
    s.reply('The first is at **ten**.', 'idle');
    await s.tick();
    expect(s.spoken().slice(1)).toEqual(['You have two meetings.', 'The first is at ten.']);
    expect(s.store.getCall('c1')?.waiting).toBeNull();
  });

  it('speaks a line from the live stream before it commits, without repeating it', async () => {
    await s.say('check my tasks');
    s.axo.live.push({ callId: 'k1', text: 'Sure, checking now. And' });
    await s.tick();
    expect(s.spoken().at(-1)).toBe('Sure, checking now.');
    s.axo.live.push({ callId: 'k1', text: 'Sure, checking now. And then some.' });
    s.axo.queue.push({ id: 'm1', source: 'assistant', text: 'Sure, checking now. And then some.', callId: 'k1' });
    await s.tick();
    expect(s.spoken().slice(1)).toEqual(['Sure, checking now.', 'And then some.']);
  });

  it('starts hold music after a live [hold] line and says no filler', async () => {
    await s.say('run the tests');
    s.axo.live.push({ callId: 'k2', text: 'Running them now. [hold]' });
    await s.tick();
    await s.evt('call.speak.ended', { call_control_id: 'c1' });
    s.axo.queue.push({ id: 'm2', source: 'assistant', text: 'Running them now. [hold]', callId: 'k2' });
    await s.tick(7000);
    expect(s.spoken().slice(1)).toEqual(['Running them now.']);
    expect(s.log.filter(l => l.startsWith('music'))).toHaveLength(1);
  });

  it('says a filler the moment Axo starts a tool without saying anything', async () => {
    await s.say('what is on my calendar');
    s.axo.tool = true;
    await s.tick(300);
    expect(s.cfg.language.strings.fillers).toContain(s.spoken().at(-1));
  });

  it('still speaks a reply that lands just after he says something else', async () => {
    await s.say('hi');
    await s.hear('what can you help with');
    s.reply('Hey! What can I do for you?', 'working');
    await s.tick(1200);
    await s.tick();
    expect(s.spoken()).toContain('Hey! What can I do for you?');
    expect(s.sent.at(-1)?.text).toBe('[Channel: Phone call] [From: Johan] what can you help with');
  });

  it('lets a single stop word cut Axo off', async () => {
    await s.say('tell me everything');
    s.reply('Here is a very long story about the deploy.', 'working');
    await s.tick();
    await s.hear('stop');
    expect(s.log).toContain('stop c1');
  });

  it('cuts Axo off on his first interim words, before the final transcript', async () => {
    await s.say('tell me everything');
    s.reply('Here is a very long story about the deploy.', 'working');
    await s.tick();
    await s.evt('call.transcription', { call_control_id: 'c1', transcription_data: { is_final: false, transcript: 'okay but' } });
    expect(s.log.at(-1)).toBe('stop c1');
    await s.hear('okay but what failed');
    await s.tick(1200);
    expect(s.sent.at(-1)?.text).toBe('[Channel: Phone call] [From: Johan] okay but what failed');
  });

  it('does not cut Axo off on an interim echo of its own words', async () => {
    await s.say('tell me everything');
    s.reply('Here is a very long story about the deploy.', 'working');
    await s.tick();
    await s.evt('call.transcription', { call_control_id: 'c1', transcription_data: { is_final: false, transcript: 'very long story about' } });
    expect(s.log).not.toContain('stop c1');
  });

  it('sends a finished sentence sooner than a trailing fragment', async () => {
    await s.spoke();
    s.working();
    await s.hear('What is on today?');
    await s.tick(400);
    expect(s.sent.at(-1)?.text).toBe('[Channel: Phone call] [From: Johan] What is on today?');
  });

  it('trusts Flux end of turn and sends an unpunctuated turn quickly', async () => {
    const f = setup();
    f.axo.stt = 'deepgram/flux';
    await f.pickUp();
    await f.spoke();
    f.working();
    await f.hear('check my email');
    await f.tick(400);
    expect(f.sent.at(-1)?.text).toBe('[Channel: Phone call] [From: Johan] check my email');
  });

  it('hangs up after Axo says goodbye with [Hang up]', async () => {
    await s.say('thanks, talk later');
    s.reply('Talk soon, Johan. [Hang up]');
    await s.tick();
    expect(s.spoken().at(-1)).toBe('Talk soon, Johan.');
    expect(s.log).not.toContain('hangup c1');
    await s.evt('call.speak.ended', { call_control_id: 'c1' });
    expect(s.log.at(-1)).toBe('hangup c1');
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
    await s.tick(1200);
    expect(s.sent[1].text).toBe('[Channel: Phone call] [From: Johan] check my calendar');
  });

  it('sends a new utterance right away even while Axo is still thinking', async () => {
    await s.say('first question');
    await s.hear('actually never mind');
    await s.tick(1200);
    expect(s.sent.map(x => x.text).slice(1)).toEqual(['[Channel: Phone call] [From: Johan] first question', '[Channel: Phone call] [From: Johan] actually never mind']);
  });

  it('stops speaking and passes his words on when he talks over Axo', async () => {
    await s.say('tell me everything');
    s.reply('Here is a long story about the deploy and the database migration.');
    await s.tick();
    await s.hear('stop stop, just the summary');
    expect(s.log).toContain('stop c1');
    await s.tick(1200);
    expect(s.sent.at(-1)).toMatchObject({ text: '[Channel: Phone call] [From: Johan] stop stop, just the summary', delivery: 'interrupt' });
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
    await s.tick(1200);
    expect(s.spoken()).not.toContain('And then the migration ran for hours.');
    expect(s.sent.at(-1)?.text).toBe('[Channel: Phone call] [From: Johan] wait a second what broke');
  });

  it('ignores its own voice and short backchannels while speaking, but hears him right after', async () => {
    await s.hear('Hey Johan what is up');
    await s.hear('okay');
    await s.evt('call.speak.ended', { call_control_id: 'c1' });
    await s.hear('Hey Johan, what is up');
    s.clock.now += 300;
    await s.hear('anything new today');
    await s.tick(5000);
    expect(s.log).not.toContain('stop c1');
    expect(s.sent.map(x => x.text).slice(1)).toEqual(['[Channel: Phone call] [From: Johan] anything new today']);
  });

  it('waits while interim results show he is still talking', async () => {
    await s.spoke();
    await s.hear('can you check the');
    const partial = (text: string) =>
      s.evt('call.transcription', { call_control_id: 'c1', transcription_data: { is_final: false, transcript: text } });
    s.clock.now += 800;
    await partial('daily');
    s.clock.now += 800;
    await partial('daily brief for');
    await s.tick(800);
    expect(s.sent).toHaveLength(1);
    await s.hear('daily brief for today');
    await s.tick(1200);
    expect(s.sent.at(-1)?.text).toBe('[Channel: Phone call] [From: Johan] can you check the daily brief for today');
  });

  it('drops a late echo of its own holding phrase but keeps real speech', async () => {
    await s.say('long question');
    await s.tick(7000);
    const filler = s.spoken().at(-1) ?? '';
    expect(s.cfg.language.strings.fillers).toContain(filler);
    await s.spoke();
    await s.hear(filler.toLowerCase().replace(/[,.]/g, ''));
    await s.hear(filler.replace('.', '!'));
    await s.tick(1200);
    expect(s.sent).toHaveLength(2);
    await s.say('thanks, retry the deploy');
    expect(s.sent.at(-1)?.text).toBe('[Channel: Phone call] [From: Johan] thanks, retry the deploy');
  });

  it('puts him on hold right after Axo announces long work and cuts the music for the next message', async () => {
    await s.say('run the full test suite');
    s.reply('Let me run the tests. [hold]', 'working');
    await s.tick();
    expect(s.spoken().at(-1)).toBe('Let me run the tests.');
    expect(s.log.filter(l => l.startsWith('music'))).toEqual([]);
    await s.evt('call.speak.ended', { call_control_id: 'c1' });
    expect(s.log.at(-1)).toBe('music c1 https://g4f4r0-axo.hellogafaro.workers.dev/hold.mp3');
    await s.tick(30_000);
    expect(s.log.filter(l => l.startsWith('music'))).toHaveLength(1);
    s.reply('All 56 tests pass.');
    await s.tick();
    expect(s.log.slice(-2)).toEqual(['stop c1', 'speak c1 All 56 tests pass.']);
  });

  it('plays no music for a quick answer', async () => {
    await s.say('what time is it');
    s.reply('Let me check.', 'working');
    await s.tick();
    await s.spoke();
    await s.tick(4000);
    s.reply('It is seven.');
    await s.tick();
    expect(s.log.filter(l => l.startsWith('music'))).toEqual([]);
  });

  it('falls back to music after a long quiet stretch without the hold tag', async () => {
    await s.say('long question');
    await s.tick(7000);
    expect(s.cfg.language.strings.fillers).toContain(s.spoken().at(-1));
    await s.spoke();
    await s.tick(5000);
    expect(s.log.filter(l => l.startsWith('music'))).toEqual([]);
    await s.tick(1200);
    expect(s.log.at(-1)).toBe('music c1 https://g4f4r0-axo.hellogafaro.workers.dev/hold.mp3');
  });

  it('stops the music when he talks during hold', async () => {
    await s.say('long question');
    s.reply('Digging in. [hold]', 'working');
    await s.tick();
    await s.spoke();
    expect(s.log.at(-1)).toBe('music c1 https://g4f4r0-axo.hellogafaro.workers.dev/hold.mp3');
    await s.hear('actually skip it');
    expect(s.log.at(-1)).toBe('stop c1');
    await s.tick(1200);
    expect(s.sent.at(-1)?.text).toBe('[Channel: Phone call] [From: Johan] actually skip it');
  });

  it('keeps the call going when reading replies fails for a moment', async () => {
    await s.say('status');
    s.axo.readFails = 2;
    await s.tick();
    await s.tick(300);
    expect(s.log).not.toContain('hangup c1');
    s.reply('All green.');
    await s.tick(300);
    expect(s.spoken().at(-1)).toBe('All green.');
  });

  it('keeps listening if a speak.ended event never arrives', async () => {
    s.clock.now += 61_000;
    await s.hear('are you there');
    await s.tick(1200);
    expect(s.sent.at(-1)?.text).toBe('[Channel: Phone call] [From: Johan] are you there');
  });

  it('stops waiting quietly when Axo ends its turn without a message', async () => {
    await s.say('thanks');
    s.axo.status = 'idle';
    await s.tick(1200);
    expect(s.store.getCall('c1')?.waiting).toBeNull();
    expect(s.spoken()).not.toContain('Something went wrong on my side. Please try again later. Goodbye.');
  });

  it('gives up after the reply timeout and says so', async () => {
    await s.say('long question');
    await s.tick(s.cfg.replyTimeoutMs + 1000);
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
    expect(s.sent[1].text).toMatch(/^\[Channel: Phone call\] \[Event: Silence\] \[Duration: 2\ds\] Check in/);
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
    expect(s.sent.at(-1)?.text).toMatch(/^\[Channel: Phone call\] \[Event: Call ended\] \[Duration: 1m 1\ds\] \[Ended by: Johan\] /);
    expect(s.store.getCall('c1')).toBeUndefined();
  });

  it('runs Axo on low reasoning during the call and restores its usual setting at the end', async () => {
    await s.say('quick one');
    for (const x of s.sent) expect(x.model).toEqual({ modelId: 'anthropic/claude-sonnet-5-5', reasoningMode: 'low' });
    await s.evt('call.hangup', { call_control_id: 'c1', hangup_source: 'caller' });
    expect(s.sent.at(-1)?.model).toEqual({ modelId: 'anthropic/claude-sonnet-5-5', reasoningMode: 'high' });
  });

  it('restores the model even when the hangup event never arrives', async () => {
    await s.tick(s.cfg.maxCallMs);
    await s.tick(11_000);
    expect(s.sent.at(-1)?.text).toMatch(/\[Event: Call ended\]/);
    expect(s.sent.at(-1)?.model?.reasoningMode).toBe('high');
    await s.evt('call.hangup', { call_control_id: 'c1', hangup_source: 'callee' });
    expect(s.sent.filter(x => x.text.includes('[Event: Call ended]'))).toHaveLength(1);
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

describe('call model', () => {
  it('switches to the configured call model with fast mode when offered, and restores Axo\'s own model', async () => {
    const s = setup({ CAPY_CALL_MODEL_ID: 'anthropic/claude-opus-5-5' });
    await s.ring();
    expect(s.sent[0].model).toEqual({ modelId: 'anthropic/claude-opus-5-5', reasoningMode: 'low', modes: { fast: true } });
    await s.evt('call.hangup', { call_control_id: 'c1', hangup_source: 'caller' });
    expect(s.sent.at(-1)?.model).toEqual({ modelId: 'anthropic/claude-sonnet-5-5', reasoningMode: 'high' });
  });

  it('skips fast mode when the model does not offer it or CAPY_CALL_FAST_MODE is false', async () => {
    const s = setup({ CAPY_CALL_MODEL_ID: 'anthropic/claude-haiku-5-5' });
    await s.ring();
    expect(s.sent[0].model).toEqual({ modelId: 'anthropic/claude-haiku-5-5', reasoningMode: 'low' });
    const n = setup({ CAPY_CALL_MODEL_ID: 'anthropic/claude-opus-5-5', CAPY_CALL_FAST_MODE: 'false' });
    await n.ring();
    expect(n.sent[0].model).toEqual({ modelId: 'anthropic/claude-opus-5-5', reasoningMode: 'low' });
  });

  it('leaves the model alone when it cannot read it or when switched off', async () => {
    const s = setup();
    s.axo.models = { current: null, fast: [] };
    await s.ring();
    expect(s.sent[0].model).toBeUndefined();
    await s.evt('call.hangup', { call_control_id: 'c1', hangup_source: 'caller' });
    expect(s.sent.at(-1)?.model).toBeUndefined();
    const off = setup({ CAPY_CALL_REASONING_MODE: 'off' });
    await off.ring();
    expect(off.sent[0].model).toBeUndefined();
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
    expect(s.sent[0].text).toMatch(/^\[Channel: Phone call\] \[Event: Outgoing call\] \[To: Johan\] /);
    expect(s.sent[0].text).toContain('You phoned Johan about: "Build failed"');
    expect(s.sent[0].text).toMatch(/\n\[Channel: Phone call\] \[From: Johan\] retry it$/);
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
