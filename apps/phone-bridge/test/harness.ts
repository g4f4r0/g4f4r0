import { Bridge, type CallState, type Recent, type Store } from '../src/engine';
import { parseConfig, type Env } from '../src/config';
import { encodeState } from '../src/telnyx';
import type { CapyMessage } from '../src/capy';

export const ALLOWED = '+15555550100';
export const REAL_ID = 'v3:ie0odK7cm5dCtztjy7_cbP30iOz-ruWD1g8xOEegMCBlZhv9DwtKqg';

export function setup(overrides: Partial<Env> = {}) {
  const calls = new Map<string, CallState>();
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  const archives = new Map<string, number>();
  let recent: Recent | null = null;
  const store: Store = {
    count: d => counts.get(d) ?? 0,
    increment: d => void counts.set(d, (counts.get(d) ?? 0) + 1),
    getCall: id => calls.get(id),
    putCall: s => void calls.set(s.id, s),
    deleteCall: id => void calls.delete(id),
    listCalls: () => [...calls.values()],
    markSeen: id => (seen.has(id) ? false : (seen.add(id), true)),
    archiveLater: (id, at) => void archives.set(id, at),
    dueArchives: now => [...archives].filter(([, at]) => at <= now).map(([id]) => (archives.delete(id), id)),
    nextArchiveAt: () => (archives.size ? Math.min(...archives.values()) : null),
    getRecent: () => recent,
    setRecent: r => void (recent = r),
  };
  const log: string[] = [];
  const sent: { text: string; key: string; delivery: string; thread: string }[] = [];
  const axo = { queue: [] as CapyMessage[], status: 'working', worked: true, sendFails: 0, readFails: 0, live: [] as { callId: string; text: string }[], tool: false, stt: 'deepgram/nova-3', threadStatus: 'idle', threads: 0, dead: new Set<string>(), onSend: null as null | (() => Promise<unknown>), onSpeak: null as null | ((text: string) => Promise<unknown>) };
  const hook = async (name: 'onSend' | 'onSpeak', arg = '') => {
    const f = axo[name];
    axo[name] = null;
    if (f) await f(arg);
  };
  const clock = { now: Date.UTC(2026, 10, 26, 18, 0) };
  const env = { CALLER_PHONE_NUMBER: ALLOWED, TELNYX_PHONE_NUMBER: '+15555550199', TELNYX_CONNECTION_ID: 'c', CAPY_PROJECT_ID: 'project_x', CAPY_CAPTAIN_ID: 'jam_axo', ...overrides } as Env;
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
      speak: async (id, t, s) => {
        await hook('onSpeak', t);
        if (axo.dead.has(id)) throw new Error('telnyx /speak failed with 422: call has already ended');
        log.push(`speak ${id} ${t}${s ? ' ' + JSON.stringify(s) : ''}`);
      },
      stopSpeaking: async id => void log.push(`stop ${id}`),
      playMusic: async (id, url) => void log.push(`music ${id} ${url}`),
      startTranscription: async id => (log.push(`stt ${id}`), axo.stt),
      hangup: async id => void log.push(`hangup ${id}`),
      dial: async s => (log.push(`dial ${JSON.stringify(s)}`), 'out-1'),
    },
    capy: {
      createThread: async (text, key) => {
        if (axo.sendFails > 0 && axo.sendFails--) throw new Error('capy down');
        await hook('onSend');
        sent.push({ text, key, delivery: 'interrupt', thread: 'new' });
        return ++axo.threads === 1 ? 'jam_call' : `jam_call${axo.threads}`;
      },
      send: async (thread, text, key, delivery = 'interrupt') => {
        if (axo.sendFails > 0 && axo.sendFails--) throw new Error('capy down');
        await hook('onSend');
        sent.push({ text, key, delivery, thread });
        return `01MSG${String(++m).padStart(21, '0')}`;
      },
      archive: async thread => void log.push(`archive ${thread}`),
      status: async () => axo.threadStatus,
      readReplies: async (_thread, afterId) => {
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
  const drop = (id = 'c1', source = 'caller') => {
    axo.dead.add(id);
    return evt('call.hangup', { call_control_id: id, hangup_source: source, hangup_cause: 'normal_clearing' });
  };
  const spoken = () => log.filter(l => l.startsWith('speak')).map(l => l.replace(/^speak \S+ /, ''));
  return { bridge, drop, store, log, sent, axo, clock, evt, tick, reply, working, spoke, hear, say, ring, pickUp, spoken, cfg };
}

export type S = ReturnType<typeof setup>;
