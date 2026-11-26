import type { Config } from './config';
import type { CapyApi } from './capy';
import type { TelnyxApi } from './telnyx';
import { decodeState } from './telnyx';
import { dayKey, isAllowedCaller, reserveOutbound, type CountStore } from './guards';
import { toSpeech } from './speech';

export interface CallState {
  id: string;
  kind: 'in' | 'out';
  startedAt: number;
  deadline: number;
  pending: string;
  lastFinalAt: number;
  waiting: null | { sentAt: number; afterId: string; spoken: number; lastHoldAt: number; seen: string[] };
  introduced: boolean;
  alert: string;
  byeAt: number | null;
  turns: number;
  speaking: number;
  quietUntil: number;
  recent: { text: string; at: number }[];
}

export interface Store extends CountStore {
  getCall(id: string): CallState | undefined;
  putCall(state: CallState): void;
  deleteCall(id: string): void;
  listCalls(): CallState[];
  markSeen(eventId: string, now: number): boolean;
}

export interface Deps {
  cfg: Config;
  telnyx: TelnyxApi;
  capy: CapyApi;
  store: Store;
  now: () => number;
  setAlarm: (at: number | null) => Promise<void>;
  log: (message: string) => void;
}

export interface TelnyxEvent {
  data?: {
    event_type?: string;
    id?: string;
    payload?: Record<string, any>;
  };
}

export type OutboundResult = { ok: true; callControlId: string } | { ok: false; reason: 'cap' | 'telnyx' };

const BYE_GRACE_MS = 10_000;
const STILL_WORKING_EVERY_MS = 30_000;
const STATUS_CHECK_AFTER_MS = 30_000;
const ECHO_TAIL_MS = 1_500;
const SPEAK_STUCK_MS = 60_000;
const ECHO_WINDOW_MS = 30_000;
const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(w => (/^\d$/.test(w) ? DIGITS[Number(w)] : w.replace(/s$/, '')));

export function isEcho(heard: string, recent: { text: string; at: number }[], now: number): boolean {
  const said = new Set(recent.filter(r => now - r.at <= ECHO_WINDOW_MS).flatMap(r => words(r.text)));
  const heardWords = words(heard);
  if (!heardWords.length || !said.size) return false;
  return heardWords.filter(w => said.has(w)).length / heardWords.length >= 0.8;
}

export class Bridge {
  constructor(private d: Deps) {}

  async handleEvent(evt: TelnyxEvent): Promise<void> {
    const { cfg, telnyx, store } = this.d;
    const data = evt.data;
    const type = data?.event_type;
    const p = data?.payload ?? {};
    const id: string | undefined = p.call_control_id;
    if (!type || !id) return;
    if (data?.id && !store.markSeen(data.id, this.d.now())) return;

    if (type === 'call.initiated') {
      if (p.direction !== 'incoming') return;
      if (!isAllowedCaller(p.from, cfg.allowedCaller)) {
        this.d.log('rejected inbound call from a number that is not allowed');
        await telnyx.reject(id);
        return;
      }
      await telnyx.answer(id, { k: 'in' });
      return;
    }

    if (type === 'call.answered') {
      const cs = decodeState(p.client_state);
      if (!cs || (cs.k !== 'in' && cs.k !== 'out')) return;
      const counterparty = cs.k === 'in' ? p.from : p.to;
      if (!isAllowedCaller(counterparty, cfg.allowedCaller)) {
        await telnyx.hangup(id);
        return;
      }
      const now = this.d.now();
      const strings = cfg.language.strings;
      const call: CallState = {
        id,
        kind: cs.k,
        startedAt: now,
        deadline: now + cfg.maxCallMs,
        pending: '',
        lastFinalAt: 0,
        waiting: null,
        introduced: false,
        alert: cs.k === 'out' ? String(cs.text ?? '') : '',
        byeAt: null,
        turns: 0,
        speaking: 0,
        quietUntil: 0,
        recent: [],
      };
      if (cs.k === 'in') {
        await this.say(call, strings.greeting);
        await telnyx.startTranscription(id);
      } else if (cs.listen) {
        await this.say(call, `${cs.text} ${strings.replyListen}`);
        await telnyx.startTranscription(id);
      } else {
        store.putCall(call);
        await telnyx.speak(id, String(cs.text ?? ''), { end: true });
      }
      await this.rearm();
      return;
    }

    if (type === 'call.speak.ended') {
      const cs = decodeState(p.client_state);
      if (cs?.end) {
        await telnyx.hangup(id);
        return;
      }
      const call = store.getCall(id);
      if (!call) return;
      call.speaking = Math.max(0, call.speaking - 1);
      call.quietUntil = this.d.now() + (call.speaking ? SPEAK_STUCK_MS : ECHO_TAIL_MS);
      store.putCall(call);
      return;
    }

    if (type === 'call.transcription') {
      const call = store.getCall(id);
      const t = p.transcription_data;
      const heard = String(t?.transcript ?? '').trim();
      const now = this.d.now();
      if (!call || call.byeAt || !t?.is_final || !heard) return;
      if (now < call.quietUntil || isEcho(heard, call.recent, now)) {
        this.d.log('ignored a transcript heard while or right after the bridge spoke');
        return;
      }
      call.pending = `${call.pending} ${heard}`.trim();
      call.lastFinalAt = this.d.now();
      store.putCall(call);
      await this.rearm();
      return;
    }

    if (type === 'call.hangup') {
      const { from, to, client_state, call_control_id, call_leg_id, call_session_id, connection_id, ...summary } = p;
      this.d.log(`call ended ${JSON.stringify(summary)}`);
      store.deleteCall(id);
      await this.rearm();
    }
  }

  async placeOutbound(text: string, listen: boolean): Promise<OutboundResult> {
    const { cfg, store, telnyx } = this.d;
    const day = dayKey(this.d.now(), cfg.timezone);
    if (!reserveOutbound(store, day, cfg.maxOutboundPerDay)) return { ok: false, reason: 'cap' };
    try {
      const callControlId = await telnyx.dial({ k: 'out', text, listen });
      return { ok: true, callControlId };
    } catch (err) {
      this.d.log(`outbound dial failed: ${(err as Error).message}`);
      return { ok: false, reason: 'telnyx' };
    }
  }

  async tick(): Promise<void> {
    for (const call of this.d.store.listCalls()) {
      try {
        await this.tickCall(call);
      } catch (err) {
        this.d.log(`tick error: ${(err as Error).message}`);
        await this.endWith(call, this.d.cfg.language.strings.failure);
      }
    }
    await this.rearm();
  }

  private async endWith(call: CallState, message: string): Promise<void> {
    if (call.byeAt) return;
    call.byeAt = this.d.now();
    call.waiting = null;
    call.pending = '';
    this.d.store.putCall(call);
    try {
      await this.d.telnyx.speak(call.id, message, { end: true });
    } catch {
      await this.d.telnyx.hangup(call.id).catch(() => undefined);
    }
  }

  private async tickCall(call: CallState): Promise<void> {
    const { cfg, telnyx, capy, store } = this.d;
    const strings = cfg.language.strings;
    const now = this.d.now();

    if (call.byeAt) {
      if (now - call.byeAt >= BYE_GRACE_MS) {
        await telnyx.hangup(call.id).catch(() => undefined);
        store.deleteCall(call.id);
      }
      return;
    }
    if (now >= call.deadline) return this.endWith(call, strings.timeLimit);

    if (!call.waiting && call.pending && now - call.lastFinalAt >= cfg.debounceMs) {
      const heard = call.pending;
      call.pending = '';
      const text = this.compose(call, heard);
      call.introduced = true;
      call.turns++;
      const afterId = await capy.send(text, `phone-${call.startedAt}-${call.turns}`);
      call.waiting = { sentAt: now, afterId, spoken: 0, lastHoldAt: 0, seen: [] };
      store.putCall(call);
      return;
    }

    const w = call.waiting;
    if (!w) return;

    const page = await capy.listAfter(w.afterId);
    for (const m of page.items) {
      if (m.source !== 'assistant' || w.seen.includes(m.id)) continue;
      w.seen.push(m.id);
      const speech = toSpeech(m.text, cfg.maxSpokenChars, strings.link, strings.truncated);
      if (!speech) continue;
      w.spoken++;
      await this.say(call, speech);
    }
    if (page.cursor) w.afterId = page.cursor;

    const elapsed = now - w.sentAt;
    if (w.spoken > 0 || elapsed >= STATUS_CHECK_AFTER_MS) {
      const status = await capy.status();
      if (status === 'failed' && w.spoken === 0) return this.endWith(call, strings.failure);
      if (w.spoken > 0 && status !== 'working') {
        call.waiting = null;
        store.putCall(call);
        return;
      }
    }
    if (elapsed >= cfg.replyTimeoutMs) {
      if (w.spoken === 0) return this.endWith(call, strings.replyTimeout);
      call.waiting = null;
      store.putCall(call);
      return;
    }
    if (w.spoken === 0 && elapsed >= cfg.holdAfterMs) {
      if (w.lastHoldAt === 0) {
        w.lastHoldAt = now;
        await this.say(call, strings.hold);
      } else if (now - w.lastHoldAt >= STILL_WORKING_EVERY_MS) {
        w.lastHoldAt = now;
        await this.say(call, strings.stillWorking);
      }
    }
    store.putCall(call);
  }

  private async say(call: CallState, text: string): Promise<void> {
    const now = this.d.now();
    call.speaking++;
    call.quietUntil = now + SPEAK_STUCK_MS;
    call.recent = [...call.recent.filter(r => now - r.at <= ECHO_WINDOW_MS), { text, at: now }];
    this.d.store.putCall(call);
    await this.d.telnyx.speak(call.id, text);
  }

  private compose(call: CallState, heard: string): string {
    const lang = this.d.cfg.language;
    if (call.introduced) return `[phone call] ${heard}`;
    const rules = `This message comes from a live phone call with Johan. Your reply is spoken aloud: answer in ${lang.name}, in short plain sentences, with no markdown, lists, tables or links, and keep it under about 40 words unless he asks for detail.`;
    const alert = call.alert ? ` You phoned him to tell him: "${call.alert}".` : '';
    return `[phone call] ${rules}${alert} What he said: ${heard}`;
  }

  private async rearm(): Promise<void> {
    const { cfg, store } = this.d;
    const now = this.d.now();
    let next: number | null = null;
    const at = (t: number) => {
      next = next === null ? t : Math.min(next, t);
    };
    for (const c of store.listCalls()) {
      at(c.byeAt ? c.byeAt + BYE_GRACE_MS : c.deadline);
      if (c.waiting) at(now + cfg.pollMs);
      else if (c.pending) at(c.lastFinalAt + cfg.debounceMs);
    }
    await this.d.setAlarm(next === null ? null : Math.max(next, now + 250));
  }
}
