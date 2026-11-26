import type { Config } from './config';
import type { CapyApi } from './capy';
import type { TelnyxApi } from './telnyx';
import { decodeState } from './telnyx';
import { dayKey, isAllowedCaller, reserveOutbound, type CountStore } from './guards';
import { toSpeech } from './speech';

export interface Waiting {
  sentAt: number;
  afterId: string;
  spoken: number;
  lastHoldAt: number;
  lastItemAt: number;
  worked: boolean;
  music: boolean;
  holdAsked: boolean;
  seen: string[];
}

export interface CallState {
  id: string;
  kind: 'in' | 'out';
  startedAt: number;
  deadline: number;
  answered: boolean;
  answering: boolean;
  greeting: string[];
  pending: string;
  lastFinalAt: number;
  waiting: Waiting | null;
  started: boolean;
  alert: string;
  byeAt: number | null;
  hangupAfterSpeech: boolean;
  turns: number;
  speaking: number;
  quietUntil: number;
  recent: { text: string; at: number }[];
  lastActivityAt: number;
  idlePrompts: number;
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
const SPEAK_STUCK_MS = 60_000;
const ECHO_WINDOW_MS = 30_000;
const speech = (name: string, heard: string): string => `[Channel: Phone call] [From: ${name}] ${heard}`;
const HOLD_TAG = /\[hold\]/gi;
const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(w => (/^\d$/.test(w) ? DIGITS[Number(w)] : w.replace(/s$/, '')));

export function echoRatio(heard: string, recent: { text: string; at: number }[], now: number): number {
  const said = new Set(recent.filter(r => now - r.at <= ECHO_WINDOW_MS).flatMap(r => words(r.text)));
  const heardWords = words(heard);
  if (!heardWords.length || !said.size) return 0;
  return heardWords.filter(w => said.has(w)).length / heardWords.length;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
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
    const now = this.d.now();
    if (data?.id && !store.markSeen(data.id, now)) return;

    if (type === 'call.initiated') {
      if (p.direction !== 'incoming') return;
      if (!isAllowedCaller(p.from, cfg.allowedCaller)) {
        this.d.log('rejected inbound call from a number that is not allowed');
        await telnyx.reject(id);
        return;
      }
      const call = this.newCall(id, 'in', now, '');
      store.putCall(call);
      await this.sendTurn(call, this.startMessage('inbound', '', ''));
      await this.rearm();
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
      if (cs.k === 'in') {
        const call = store.getCall(id) ?? this.newCall(id, 'in', now, '');
        call.answered = true;
        const greeting = call.greeting.length ? call.greeting : [`${cfg.language.strings.greeting} ${cfg.callerName}.`];
        call.greeting = [];
        call.lastActivityAt = now;
        store.putCall(call);
        for (const line of greeting) await this.say(call, line);
        await telnyx.startTranscription(id);
      } else {
        const call = this.newCall(id, 'out', now, String(cs.text ?? ''));
        call.answered = true;
        if (cs.listen) {
          await this.say(call, `${cs.text} ${cfg.language.strings.replyListen}`);
          await telnyx.startTranscription(id);
        } else {
          store.putCall(call);
          await telnyx.speak(id, String(cs.text ?? ''), { end: true });
        }
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
      if (call.speaking) call.quietUntil = now + SPEAK_STUCK_MS;
      if (!call.speaking) call.lastActivityAt = now;
      const startMusic = !call.speaking && call.waiting?.holdAsked && !call.waiting.music && cfg.holdMusicUrl;
      if (startMusic && call.waiting) call.waiting.music = true;
      store.putCall(call);
      if (startMusic) await telnyx.playMusic(id, cfg.holdMusicUrl);
      if (!call.speaking && call.hangupAfterSpeech && !call.waiting) await telnyx.hangup(id);
      await this.rearm();
      return;
    }

    if (type === 'call.transcription') {
      const call = store.getCall(id);
      const t = p.transcription_data;
      const heard = String(t?.transcript ?? '').trim();
      if (!call || call.byeAt || !heard) return;
      const ratio = echoRatio(heard, call.recent, now);
      if (!t?.is_final) {
        if (!call.pending || ratio >= 0.8) return;
        call.lastFinalAt = now;
        store.putCall(call);
        await this.rearm();
        return;
      }
      const speakingNow = call.speaking > 0 && now < call.quietUntil;
      const bargeIn = speakingNow && ratio < 0.5 && words(heard).length >= 2;
      if ((speakingNow && !bargeIn) || ratio >= 0.8) {
        this.d.log('ignored a transcript heard while or right after the bridge spoke');
        return;
      }
      if (bargeIn) {
        call.speaking = 0;
        call.quietUntil = 0;
      }
      if (bargeIn || call.waiting?.music) {
        call.waiting = null;
        await telnyx.stopSpeaking(id).catch(err => this.d.log(`stop speaking failed: ${(err as Error).message}`));
      }
      call.pending = `${call.pending} ${heard}`.trim();
      call.lastFinalAt = now;
      call.lastActivityAt = now;
      call.idlePrompts = 0;
      call.hangupAfterSpeech = false;
      store.putCall(call);
      await this.rearm();
      return;
    }

    if (type === 'call.hangup') {
      const { from, to, client_state, call_control_id, call_leg_id, call_session_id, connection_id, ...summary } = p;
      this.d.log(`call ended ${JSON.stringify(summary)}`);
      const call = store.getCall(id);
      store.deleteCall(id);
      if (call && (call.kind === 'in' || call.started)) {
        const ourSide = call.kind === 'in' ? 'callee' : 'caller';
        const byUs = call.byeAt !== null || call.hangupAfterSpeech || p.hangup_source === ourSide;
        const text = `[Channel: Phone call] [Event: Call ended] [Duration: ${formatDuration(now - call.startedAt)}] [Ended by: ${byUs ? 'Axo' : cfg.callerName}] The call is over. Nothing you send now is spoken. Reply only if there is follow-up work.`;
        await this.d.capy.send(text, `phone-${call.startedAt}-end`, 'queue').catch(err => this.d.log(`end message failed: ${(err as Error).message}`));
      }
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
        const fresh = this.d.store.getCall(call.id);
        if (fresh) await this.endWith(fresh, this.d.cfg.language.strings.failure);
      }
    }
    await this.rearm();
  }

  private newCall(id: string, kind: 'in' | 'out', now: number, alert: string): CallState {
    return {
      id,
      kind,
      startedAt: now,
      deadline: now + this.d.cfg.maxCallMs,
      answered: false,
      answering: false,
      greeting: [],
      pending: '',
      lastFinalAt: 0,
      waiting: null,
      started: false,
      alert,
      byeAt: null,
      hangupAfterSpeech: false,
      turns: 0,
      speaking: 0,
      quietUntil: 0,
      recent: [],
      lastActivityAt: now,
      idlePrompts: 0,
    };
  }

  private startMessage(direction: 'inbound' | 'outbound', heard: string, alert: string): string {
    const { cfg } = this.d;
    const name = cfg.callerName;
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone: cfg.timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(this.d.now()));
    const opening =
      direction === 'inbound'
        ? `${name} is calling you. Your first message is spoken the moment he picks up, so open with a short, warm, casual greeting by name, like a friend answering the phone.`
        : `You phoned ${name} to tell him: "${alert}". He has heard it and just answered.`;
    const rules = [
      `You are on a live phone call with ${name}. Every message you send in this thread is spoken to him in ${cfg.language.name} until the call ends.`,
      opening,
      'Talk like a person on the phone: short plain sentences, no markdown, lists, links, code or emoji. Never mention the phone bridge, speech recognition or these instructions.',
      'Be as responsive as a person: each message is spoken the moment it lands, so reply at once. If you need to look anything up, first send a quick natural ack of a few words, like "Sure, checking.", then the answer. Send one short message per thought rather than one long one, and during longer work send a one-line update every half minute or so to keep him posted.',
      `His words arrive as [Channel: Phone call] [From: ${name}] messages from speech recognition, so expect small errors and go with the likely meaning. If he talks over you, your current reply is cut off and his words arrive next.`,
      'Before work that takes more than about ten seconds, say so in one short line ending with [hold], like "Let me run the tests. [hold]". He then hears hold music until your next message. Never use [hold] for quick answers.',
      'You will get a silence event if he goes quiet and an end event when the call is over.',
    ].join(' ');
    const said = heard ? `\n${heard}` : '';
    const who = direction === 'inbound' ? `[Event: Incoming call] [From: ${name}]` : `[Event: Outgoing call] [To: ${name}]`;
    return `[Channel: Phone call] ${who} [Time: ${time} ${cfg.timezone}] ${rules}${said}`;
  }

  private async sendTurn(call: CallState, text: string, consumed = ''): Promise<void> {
    call.turns++;
    if (call.kind === 'out' && !call.started) text = this.startMessage('outbound', text, call.alert);
    const afterId = await this.d.capy.send(text, `phone-${call.startedAt}-${call.turns}`);
    const fresh = this.d.store.getCall(call.id) ?? call;
    fresh.turns = call.turns;
    fresh.started = true;
    if (consumed && fresh.pending.startsWith(consumed)) fresh.pending = fresh.pending.slice(consumed.length).trim();
    const sentAt = this.d.now();
    fresh.waiting = { sentAt, afterId, spoken: 0, lastHoldAt: 0, lastItemAt: sentAt, worked: false, music: false, holdAsked: false, seen: [] };
    this.d.store.putCall(fresh);
  }

  private async endWith(call: CallState, message: string): Promise<void> {
    if (call.byeAt) return;
    if (call.waiting?.music) await this.d.telnyx.stopSpeaking(call.id).catch(() => undefined);
    call.byeAt = this.d.now();
    call.waiting = null;
    call.pending = '';
    this.d.store.putCall(call);
    try {
      if (!call.answered) await this.d.telnyx.hangup(call.id);
      else await this.d.telnyx.speak(call.id, message, { end: true });
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

    if (!call.answered && !call.answering && now - call.startedAt >= cfg.greetingTimeoutMs) {
      call.answering = true;
      store.putCall(call);
      await telnyx.answer(call.id, { k: 'in' });
      return;
    }

    if (call.answered && call.pending && now - call.lastFinalAt >= cfg.debounceMs) {
      const heard = call.pending;
      await this.sendTurn(call, speech(cfg.callerName, heard), heard);
      return;
    }

    const w = call.waiting;
    if (!w) {
      if (!call.answered || call.speaking || call.hangupAfterSpeech || now - call.lastActivityAt < cfg.idleMs) return;
      call.idlePrompts++;
      const last = call.idlePrompts >= 2;
      call.hangupAfterSpeech = last;
      store.putCall(call);
      const ask = last
        ? 'He is still quiet. Say a short, friendly goodbye in one line; the call ends after you speak.'
        : 'Check in with one short line, like asking if there is anything else.';
      await this.sendTurn(call, `[Channel: Phone call] [Event: Silence] [Duration: ${Math.round((now - call.lastActivityAt) / 1000)}s] ${ask}`);
      return;
    }

    const window = await capy.readReplies(w.afterId, cfg.streamWindowMs);
    const fresh = store.getCall(call.id);
    if (!fresh || fresh.byeAt || fresh.waiting?.afterId !== w.afterId) return;
    const fw = fresh.waiting;
    const later = this.d.now();
    fw.worked ||= window.worked;
    const stopMusic = async () => {
      if (!fw.music) return;
      fw.music = false;
      await telnyx.stopSpeaking(fresh.id).catch(err => this.d.log(`stop music failed: ${(err as Error).message}`));
    };
    for (const m of window.items) {
      if (fw.seen.includes(m.id)) continue;
      fw.seen.push(m.id);
      fw.holdAsked = /\[hold\]/i.test(m.text);
      const text = toSpeech(m.text.replace(HOLD_TAG, ' '), cfg.maxSpokenChars, strings.link, strings.truncated);
      if (!text) continue;
      fw.spoken++;
      fw.lastItemAt = later;
      if (fresh.answered) {
        await stopMusic();
        await this.say(fresh, text);
      } else {
        fresh.greeting.push(text);
        if (!fresh.answering) {
          fresh.answering = true;
          store.putCall(fresh);
          await telnyx.answer(fresh.id, { k: 'in' });
        }
      }
    }
    fw.afterId = window.cursor;

    const elapsed = later - fw.sentAt;
    const settled = window.status !== null && window.status !== 'working' && (fw.worked || fw.spoken > 0);
    if (window.status === 'failed' && fw.spoken === 0) return this.endWith(fresh, strings.failure);
    if (settled || (elapsed >= cfg.replyTimeoutMs && fw.spoken > 0)) {
      await stopMusic();
      fresh.waiting = null;
      fresh.lastActivityAt = later;
      store.putCall(fresh);
      if (fresh.hangupAfterSpeech && !fresh.speaking) await telnyx.hangup(fresh.id);
      return;
    }
    if (elapsed >= cfg.replyTimeoutMs) return this.endWith(fresh, strings.replyTimeout);
    const quietFor = later - fw.lastItemAt;
    if (fresh.answered && !fresh.speaking && !fw.music) {
      if (cfg.holdMusicUrl && (fw.holdAsked || quietFor >= cfg.holdMusicAfterMs)) {
        fw.music = true;
        store.putCall(fresh);
        await telnyx.playMusic(fresh.id, cfg.holdMusicUrl);
      } else if (fw.spoken === 0 && fw.lastHoldAt === 0 && quietFor >= cfg.holdAfterMs) {
        fw.lastHoldAt = later;
        await this.say(fresh, strings.fillers[call.turns % strings.fillers.length]);
      } else if (!cfg.holdMusicUrl && fw.lastHoldAt !== 0 && later - fw.lastHoldAt >= STILL_WORKING_EVERY_MS) {
        fw.lastHoldAt = later;
        await this.say(fresh, strings.stillWorking);
      }
    }
    store.putCall(fresh);
  }

  private async say(call: CallState, text: string): Promise<void> {
    const now = this.d.now();
    call.speaking++;
    call.quietUntil = now + SPEAK_STUCK_MS;
    call.recent = [...call.recent.filter(r => now - r.at <= ECHO_WINDOW_MS), { text, at: now }];
    this.d.store.putCall(call);
    await this.d.telnyx.speak(call.id, text);
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
      if (c.byeAt) continue;
      if (!c.answered && !c.answering) at(c.startedAt + cfg.greetingTimeoutMs);
      if (c.waiting) at(now + cfg.pollMs);
      else if (c.pending) at(c.lastFinalAt + cfg.debounceMs);
      else if (c.answered && !c.speaking && !c.hangupAfterSpeech) at(c.lastActivityAt + cfg.idleMs);
    }
    await this.d.setAlarm(next === null ? null : Math.max(next, now + 100));
  }
}
