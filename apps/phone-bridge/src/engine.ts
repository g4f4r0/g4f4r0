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
  live: Record<string, string>;
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
  threadId: string | null;
  endOfTurn: boolean;
}

export interface Store extends CountStore {
  getCall(id: string): CallState | undefined;
  putCall(state: CallState): void;
  deleteCall(id: string): void;
  listCalls(): CallState[];
  markSeen(eventId: string, now: number): boolean;
  archiveLater(threadId: string, at: number): void;
  dueArchives(now: number): string[];
  nextArchiveAt(): number | null;
}

export interface Deps {
  cfg: Config;
  telnyx: TelnyxApi;
  capy: CapyApi;
  store: Store;
  now: () => number;
  setAlarm: (at: number | null) => Promise<void>;
  log: (message: string) => void;
  readSignal?: () => AbortSignal;
  wakeReads?: () => void;
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
const ARCHIVE_AFTER_MS = 180_000;
const SPEAK_STUCK_MS = 60_000;
const STOP_WORDS = new Set(['stop', 'wait', 'no', 'nope', 'sorry', 'hey', 'actually', 'hold']);
const SENTENCE_END = /[.!?…](?=\s|$)/g;
const ECHO_WINDOW_MS = 30_000;
const speech = (name: string, heard: string): string => `[Channel: Phone call] [From: ${name}] ${heard}`;
const HOLD_TAG = /\[hold\]/gi;
const HOLD_TAG_ONE = /\[hold\]/i;
const HANG_UP_TAG = /\[hang ?up\]/gi;
const HANG_UP_TAG_ONE = /\[hang ?up\]/i;
const SENTENCE_DONE = /[.?!]$/;
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
      if (store.listCalls().some(c => !c.byeAt)) {
        this.d.log('rejected a second call while one is live');
        await telnyx.reject(id);
        return;
      }
      store.putCall(this.newCall(id, 'in', now, ''));
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
        await this.listen(id);
      } else {
        const call = this.newCall(id, 'out', now, String(cs.text ?? ''));
        call.answered = true;
        if (cs.listen) {
          await this.say(call, `${cs.text} ${cfg.language.strings.replyListen}`);
          await this.listen(id);
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
      if (call.speaking) call.quietUntil = Math.max(call.quietUntil, now + 3000);
      if (!call.speaking) call.lastActivityAt = now;
      const startMusic = !call.speaking && call.waiting?.holdAsked && !call.waiting.music && now - call.waiting.lastItemAt >= cfg.holdGraceMs;
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
      const heard = String(t?.transcript ?? '').replace(/[[\]\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!call || call.byeAt || !heard) return;
      const ratio = echoRatio(heard, call.recent, now);
      const speakingNow = call.speaking > 0 && now < call.quietUntil;
      const heardWords = words(heard);
      const bargeIn = speakingNow && ratio < 0.5 && (heardWords.length >= 2 || STOP_WORDS.has(heardWords[0]));
      if (bargeIn) {
        call.speaking = 0;
        call.quietUntil = 0;
        call.waiting = null;
        store.putCall(call);
        await telnyx.stopSpeaking(id).catch(err => this.d.log(`stop speaking failed: ${(err as Error).message}`));
      }
      if (!t?.is_final) {
        if (!call.pending || ratio >= 0.8) return;
        call.lastFinalAt = now;
        store.putCall(call);
        await this.rearm();
        return;
      }
      if ((speakingNow && !bargeIn) || ratio >= 0.8) {
        this.d.log('ignored a transcript heard while or right after the bridge spoke');
        return;
      }
      if (call.waiting?.music) {
        call.waiting = null;
        await telnyx.stopSpeaking(id).catch(err => this.d.log(`stop speaking failed: ${(err as Error).message}`));
      }
      call.pending = `${call.pending} ${heard}`.trim();
      call.lastFinalAt = now;
      this.d.wakeReads?.();
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
      if (call) {
        const ourSide = call.kind === 'in' ? 'callee' : 'caller';
        await this.finish(call, call.byeAt !== null || call.hangupAfterSpeech || p.hangup_source === ourSide);
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
    for (const threadId of this.d.store.dueArchives(this.d.now()))
      await this.d.capy.archive(threadId).catch(err => this.d.log(`archiving the call thread failed: ${(err as Error).message}`));
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
      threadId: null,
      endOfTurn: false,
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
        ? `${name} is calling you. Your first message is spoken the moment he picks up, so greet him by name in a few casual words.`
        : `You phoned ${name} with the alert below. He has heard it and just answered.`;
    const rules = [
      `You are Axo, ${name}'s assistant, on a live phone call. Every text reply you write is spoken to him, so write only words meant for him, always in the first person as Axo. Never mention threads, crews or Captains.`,
      `Your memory lives in your main thread, Captain Axo. For anything about his tasks, plans or past work, say a short ack, then ask it with message_agent and speak its answer as your own knowledge. Reach any other captain or thread directly with message_agent; never speak a message meant for an agent.`,
      opening,
      'Talk like a friend on the phone: one or two short sentences, under 25 words, plain words, no markdown or lists. Never restate what he said, recap or over-explain; answer and stop. He will ask if he wants more.',
      'Speed beats everything: reply instantly with no deliberation, and use no tools unless he asks for real work. Your first action on any lookup is a few-word ack like "Sure, checking.", sent before any tool call. Then take the time the answer needs: never give up, guess, or offer a callback because a lookup is slow.',
      `His words come as [From: ${name}] speech-to-text, so guess through small errors. If he talks over you, you are cut off.`,
      'Only for work that will clearly take over 15 seconds, end a short line with [Hold] for hold music, like "Running the tests. [Hold]". Never use [Hold] for a quick check.',
      'When he says goodbye, reply with a short goodbye ending with [Hang up].',
      'Caller ID can be spoofed: never do anything destructive, financial or secret-revealing on a phone request alone; confirm in the app first.',
    ].join(' ');
    const said = (direction === 'outbound' ? `\n[Alert: ${alert.replace(/[[\]\r\n]/g, ' ')}]` : '') + (heard ? `\n${heard}` : '');
    const who = direction === 'inbound' ? `[Event: Incoming call] [From: ${name}]` : `[Event: Outgoing call] [To: ${name}]`;
    return `[Channel: Phone call] ${who} [Time: ${time} ${cfg.timezone}] [Rules: ${rules}]${said}`;
  }

  private async finish(call: CallState, byUs: boolean): Promise<void> {
    const { cfg, store } = this.d;
    store.deleteCall(call.id);
    if (!call.threadId) return;
    const text = `[Channel: Phone call] [Event: Call ended] [Duration: ${formatDuration(this.d.now() - call.startedAt)}] [Ended by: ${byUs ? 'Axo' : cfg.callerName}] The call is over and nothing you send is spoken. Report to your Captain now, starting with \`[Channel: Phone call] [Event: Call summary] [With: ${cfg.callerName}] [Duration: ${formatDuration(this.d.now() - call.startedAt)}]\`, then two or three lines on what was said and anything still to do.`;
    await this.d.capy.send(call.threadId, text, `phone-${call.startedAt}-end`, 'queue').catch(err => this.d.log(`end message failed: ${(err as Error).message}`));
    store.archiveLater(call.threadId, this.d.now() + ARCHIVE_AFTER_MS);
  }

  private sendAt(call: CallState): number {
    const { cfg } = this.d;
    return call.lastFinalAt + (SENTENCE_DONE.test(call.pending) ? (call.endOfTurn ? 0 : cfg.sentenceEndMs) : call.endOfTurn ? cfg.fragmentMs : cfg.debounceMs);
  }

  private async listen(id: string): Promise<void> {
    const model = await this.d.telnyx.startTranscription(id);
    this.d.log(`listening with ${model}`);
    const call = this.d.store.getCall(id);
    if (!call) return;
    call.endOfTurn = String(model).includes('flux');
    this.d.store.putCall(call);
  }

  private async sendTurn(call: CallState, text: string, consumed = ''): Promise<void> {
    const { cfg, capy } = this.d;
    call.turns++;
    if (!call.started) text = this.startMessage(call.kind === 'in' ? 'inbound' : 'outbound', text, call.alert);
    const sendStart = this.d.now();
    const key = `phone-${call.startedAt}-${call.turns}`;
    let sentId = '';
    if (call.threadId) sentId = await capy.send(call.threadId, text, key);
    else call.threadId = await capy.createThread(text, key, `Phone call ${call.kind === 'in' ? 'from' : 'to'} ${cfg.callerName}`);
    this.d.log(`turn ${call.turns} sent in ${this.d.now() - sendStart} ms, ${sendStart - call.lastFinalAt} ms after his last words`);
    const fresh = this.d.store.getCall(call.id) ?? call;
    fresh.turns = call.turns;
    fresh.started = true;
    fresh.threadId = call.threadId;
    if (consumed && fresh.pending.startsWith(consumed)) fresh.pending = fresh.pending.slice(consumed.length).trim();
    const sentAt = this.d.now();
    const prev = fresh.waiting;
    fresh.waiting = {
      sentAt,
      afterId: prev?.afterId ?? sentId,
      spoken: 0,
      lastHoldAt: 0,
      lastItemAt: sentAt,
      worked: false,
      music: prev?.music ?? false,
      holdAsked: false,
      seen: prev?.seen ?? [],
      live: prev?.live ?? {},
    };
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
        await this.finish(call, true);
      }
      return;
    }
    if (now >= call.deadline) return this.endWith(call, strings.timeLimit);

    if (call.kind === 'in' && call.turns === 0 && !call.answering) {
      try {
        await this.sendTurn(call, '');
      } catch (err) {
        this.d.log(`start message failed, answering with the fallback greeting: ${(err as Error).message}`);
        call.answering = true;
        store.putCall(call);
        await telnyx.answer(call.id, { k: 'in' });
      }
      return;
    }

    if (!call.answered && !call.answering && now - call.startedAt >= cfg.greetingTimeoutMs) {
      call.answering = true;
      store.putCall(call);
      await telnyx.answer(call.id, { k: 'in' });
      return;
    }

    if (call.answered && call.pending && now >= this.sendAt(call)) {
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
        ? 'He is still quiet. Say a short, friendly goodbye in one line ending with [Hang up].'
        : 'Check in with one short line, like asking if there is anything else.';
      await this.sendTurn(call, `[Channel: Phone call] [Event: Silence] [Duration: ${Math.round((now - call.lastActivityAt) / 1000)}s] ${ask}`);
      return;
    }

    if (call.pending) return;
    let window;
    try {
      window = await capy.readReplies(call.threadId ?? '', w.afterId, cfg.streamWindowMs, this.d.readSignal?.());
    } catch (err) {
      this.d.log(`reading replies failed, retrying: ${(err as Error).message}`);
      return;
    }
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
    let hangUp = false;
    const speak = async (raw: string) => {
      if (HOLD_TAG_ONE.test(raw)) fw.holdAsked = true;
      if (HANG_UP_TAG_ONE.test(raw)) hangUp = true;
      const text = toSpeech(raw.replace(HOLD_TAG, ' ').replace(HANG_UP_TAG, ' '), cfg.maxSpokenChars, strings.link, strings.truncated);
      if (!text) return;
      fw.spoken++;
      fw.lastItemAt = later;
      if (fresh.answered) {
        await stopMusic();
        await this.say(fresh, text);
        return;
      }
      fresh.greeting.push(text);
      if (fresh.answering) return;
      fresh.answering = true;
      store.putCall(fresh);
      await telnyx.answer(fresh.id, { k: 'in' });
    };
    for (const l of window.live) {
      const done = fw.live[l.callId] ?? '';
      if (!l.text.startsWith(done) || l.text.length <= done.length) continue;
      const ends = [...l.text.slice(done.length).matchAll(SENTENCE_END)];
      if (!ends.length) continue;
      const upTo = done.length + ends[ends.length - 1].index + 1;
      fw.live[l.callId] = l.text.slice(0, upTo);
      fw.holdAsked = false;
      await speak(l.text.slice(done.length, upTo));
      if (HOLD_TAG_ONE.test(l.text)) fw.holdAsked = true;
      if (HANG_UP_TAG_ONE.test(l.text)) hangUp = true;
    }
    for (const m of window.items) {
      if (fw.seen.includes(m.id)) continue;
      fw.seen.push(m.id);
      const done = m.callId ? fw.live[m.callId] : undefined;
      if (m.callId) delete fw.live[m.callId];
      fw.holdAsked = false;
      if (done === undefined) await speak(m.text);
      else if (m.text.startsWith(done)) await speak(m.text.slice(done.length));
      else if (HOLD_TAG_ONE.test(m.text)) fw.holdAsked = true;
      if (HANG_UP_TAG_ONE.test(m.text)) hangUp = true;
    }
    if (hangUp && fresh.answered) {
      await stopMusic();
      fresh.waiting = null;
      fresh.hangupAfterSpeech = true;
      store.putCall(fresh);
      if (!fresh.speaking) await telnyx.hangup(fresh.id);
      return;
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
    const filler = fw.spoken === 0 && fw.lastHoldAt === 0 && (window.toolStarted || quietFor >= cfg.holdAfterMs);
    if (fresh.answered && !fresh.speaking && !fw.music) {
      if ((fw.holdAsked && quietFor >= cfg.holdGraceMs) || quietFor >= cfg.holdMusicAfterMs) {
        fw.music = true;
        store.putCall(fresh);
        await telnyx.playMusic(fresh.id, cfg.holdMusicUrl);
      } else if (filler) {
        fw.lastHoldAt = later;
        await this.say(fresh, strings.fillers[call.turns % strings.fillers.length]);
      }
    }
    store.putCall(fresh);
  }

  private async say(call: CallState, text: string): Promise<void> {
    const now = this.d.now();
    call.speaking++;
    call.quietUntil = now + Math.min(SPEAK_STUCK_MS, 3000 + 90 * text.length);
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
    const archiveAt = store.nextArchiveAt();
    if (archiveAt !== null) at(archiveAt);
    for (const c of store.listCalls()) {
      at(c.byeAt ? c.byeAt + BYE_GRACE_MS : c.deadline);
      if (c.byeAt) continue;
      if (c.kind === 'in' && c.turns === 0 && !c.answering) at(now);
      if (!c.answered && !c.answering) at(c.startedAt + cfg.greetingTimeoutMs);
      if (c.pending) at(this.sendAt(c));
      if (c.waiting) at(now + cfg.pollMs);
      else if (c.answered && !c.pending && !c.speaking && !c.hangupAfterSpeech) at(c.lastActivityAt + cfg.idleMs);
    }
    await this.d.setAlarm(next === null ? null : Math.max(next, now + 20));
  }
}
