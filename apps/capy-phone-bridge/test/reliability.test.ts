import { beforeEach, describe, expect, it } from 'vitest';
import { encodeState } from '../src/telnyx';
import { ALLOWED, setup, type S } from './harness';

const RESUME_MS = 300_000;
const ended = (s: S) => s.sent.filter(x => x.text.includes('[Event: Call ended]'));

describe('signal loss and redial', () => {
  let s: S;
  beforeEach(async () => {
    s = setup();
    await s.pickUp();
    await s.say('what is on my calendar');
    s.reply('Two meetings today.');
    await s.tick();
  });

  it('holds the end of a dropped call so a redial can pick it up, then reports it once', async () => {
    await s.drop();
    expect(s.store.listCalls()).toEqual([]);
    expect(ended(s)).toEqual([]);
    await s.tick(RESUME_MS - 1000);
    expect(ended(s)).toEqual([]);
    await s.tick(2000);
    expect(ended(s)).toHaveLength(1);
    expect(ended(s)[0]).toMatchObject({ thread: 'jam_call', delivery: 'queue' });
    expect(ended(s)[0].text).toContain('[Ended by: Johan]');
    await s.tick(RESUME_MS);
    expect(ended(s)).toHaveLength(1);
    expect(s.log).toContain('archive jam_call');
  });

  it('continues the same thread when he calls back after a drop, without a new greeting ceremony', async () => {
    await s.drop();
    s.clock.now += 40_000;
    await s.ring('c2');
    const resumed = s.sent.at(-1)!;
    expect(resumed.thread).toBe('jam_call');
    expect(resumed.text).toMatch(/^\[Channel: Phone call\] \[Event: Call resumed\] \[From: Johan\] /);
    expect(resumed.text).toContain('[Gap: 40s]');
    expect(resumed.text).not.toContain('[Rules:');
    expect(s.sent.filter(x => x.thread === 'new')).toHaveLength(1);
    s.reply('Hey, you are back.');
    await s.tick();
    await s.evt('call.answered', { call_control_id: 'c2', from: ALLOWED, client_state: encodeState({ k: 'in' }) });
    expect(s.spoken().at(-1)).toBe('Hey, you are back.');
    await s.drop('c2');
    await s.tick(RESUME_MS + 1000);
    expect(ended(s)).toHaveLength(1);
    expect(ended(s)[0].text).toMatch(/\[Duration: 4\ds\]/);
  });

  it('tells the thread what he missed when the line dropped mid-lookup', async () => {
    await s.say('check my tasks');
    s.axo.tool = true;
    await s.tick();
    await s.drop();
    s.reply('You have four tasks.');
    await s.tick();
    expect(s.spoken()).not.toContain('You have four tasks.');
    await s.ring('c2');
    expect(s.sent.at(-1)?.text).toContain('He did not hear the end of your last reply');
  });

  it('passes on words he said just before the line dropped', async () => {
    await s.spoke();
    await s.hear('and move the dentist to');
    await s.drop();
    await s.ring('c2');
    expect(s.sent.at(-1)?.text).toContain('"and move the dentist to"');
  });

  it('starts a fresh thread when he calls back after the window, and the old one is reported', async () => {
    await s.drop();
    await s.tick(RESUME_MS + 1000);
    await s.ring('c2');
    expect(ended(s)).toHaveLength(1);
    expect(s.sent.at(-1)).toMatchObject({ thread: 'new' });
    expect(s.sent.at(-1)?.text).toContain('[Event: Incoming call]');
  });

  it('takes a redial even when the dead leg is still on record, and hangs that leg up', async () => {
    await s.ring('c2');
    expect(s.log).not.toContain('reject c2');
    expect(s.log).toContain('hangup c1');
    expect(s.store.getCall('c1')).toBeUndefined();
    expect(s.sent.at(-1)).toMatchObject({ thread: 'jam_call' });
    expect(s.sent.at(-1)?.text).toContain('[Event: Call resumed]');
    await s.evt('call.hangup', { call_control_id: 'c1', hangup_source: 'caller' });
    expect(ended(s)).toEqual([]);
  });

  it('puts a callback Axo places into the same conversation when it lands within the window', async () => {
    await s.say('call me back in two minutes');
    s.reply('Will do, talk in two. [Hang up]');
    await s.tick();
    await s.evt('call.speak.ended', { call_control_id: 'c1' });
    await s.evt('call.hangup', { call_control_id: 'c1', hangup_source: 'callee' });
    s.clock.now += 150_000;
    await s.evt('call.answered', { call_control_id: 'o1', to: ALLOWED, client_state: encodeState({ k: 'out', text: 'Calling you back about Crispin.', listen: true }) });
    await s.say('go on', 'o1');
    const first = s.sent.at(-1)!;
    expect(first.thread).toBe('jam_call');
    expect(first.text).toMatch(/^\[Channel: Phone call\] \[Event: Call resumed\] \[To: Johan\] /);
    expect(first.text).toContain('[Alert: Calling you back about Crispin.]');
    expect(first.text).toMatch(/\n\[Channel: Phone call\] \[From: Johan\] go on$/);
    expect(ended(s)).toEqual([]);
  });
});

describe('callbacks Axo promised', () => {
  it('brings a callback 30 minutes later back into the thread that promised it', async () => {
    const s = setup();
    await s.pickUp();
    await s.say('call me in thirty minutes');
    s.reply('Will do, talk in thirty. [Hang up]');
    await s.tick();
    await s.evt('call.speak.ended', { call_control_id: 'c1' });
    await s.evt('call.hangup', { call_control_id: 'c1', hangup_source: 'callee' });
    s.axo.threadStatus = 'waiting';
    await s.tick(RESUME_MS + 1000);
    await s.tick(25 * 60_000);
    expect(s.log).not.toContain('archive jam_call');
    await s.bridge.placeOutbound('Calling you back as promised.', true, 'jam_call');
    expect(s.log).toContain('dial {"k":"out","text":"Calling you back as promised.","listen":true,"thread":"jam_call"}');
    await s.evt('call.answered', { call_control_id: 'o1', to: ALLOWED, client_state: encodeState({ k: 'out', text: 'Calling you back as promised.', listen: true, thread: 'jam_call' }) });
    await s.say('yes go ahead', 'o1');
    const first = s.sent.at(-1)!;
    expect(first.thread).toBe('jam_call');
    expect(first.text).toMatch(/^\[Channel: Phone call\] \[Event: Call resumed\] \[To: Johan\] \[Time: [^\]]+\] You phoned Johan again/);
    expect(s.sent.filter(x => x.thread === 'new')).toHaveLength(1);
  });
});

describe('drops that race the bridge', () => {
  let s: S;
  beforeEach(async () => {
    s = setup();
    await s.pickUp();
  });

  it('does not bring a call back to life when the line drops while Axo is speaking', async () => {
    await s.say('tell me everything');
    s.reply('First part.', 'working');
    s.reply('Second part.', 'working');
    s.axo.onSpeak = async () => {
      await s.evt('call.hangup', { call_control_id: 'c1', hangup_source: 'caller' });
      s.axo.onSpeak = async () => void s.axo.dead.add('c1');
    };
    await s.tick();
    expect(s.spoken().at(-1)).toBe('First part.');
    await s.tick(11_000);
    expect(s.store.listCalls()).toEqual([]);
    expect(s.log.join(' ')).not.toContain('Something went wrong');
    await s.tick(RESUME_MS);
    expect(ended(s)).toHaveLength(1);
    expect(ended(s)[0].text).toContain('[Ended by: Johan]');
  });

  it('does not bring a call back to life when the line drops while his words are being sent', async () => {
    await s.spoke();
    s.working();
    await s.hear('what is new today');
    s.axo.onSend = async () => s.drop();
    await s.tick(1200);
    expect(s.store.listCalls()).toEqual([]);
    await s.tick(RESUME_MS + 1000);
    expect(ended(s)).toHaveLength(1);
  });

  it('still reports and archives a thread whose creation raced a hang-up', async () => {
    const r = setup();
    await r.evt('call.initiated', { call_control_id: 'c1', direction: 'incoming', from: ALLOWED });
    r.axo.onSend = async () => r.drop();
    await r.tick();
    expect(r.store.listCalls()).toEqual([]);
    await r.tick(RESUME_MS + 1000);
    expect(ended(r)).toHaveLength(1);
    expect(ended(r)[0].thread).toBe('jam_call');
    await r.tick(180_000);
    expect(r.log).toContain('archive jam_call');
  });
});

describe('silence, noise and fragments', () => {
  let s: S;
  beforeEach(async () => {
    s = setup();
    await s.pickUp();
    await s.spoke();
    s.axo.status = 'idle';
    await s.tick();
  });

  const silences = () => s.sent.filter(x => x.text.includes('[Event: Silence]'));

  it('waits longer before checking in, since he is often driving', async () => {
    await s.tick(30_000);
    expect(silences()).toEqual([]);
    await s.tick(11_000);
    expect(silences()).toHaveLength(1);
  });

  it('counts a barge-in as activity, so noise that cuts Axo off does not trigger a goodbye', async () => {
    await s.tick(s.cfg.idleMs + 1000);
    s.reply('Still there?', 'working');
    await s.tick();
    await s.evt('call.transcription', { call_control_id: 'c1', transcription_data: { is_final: false, transcript: 'yeah I' } });
    await s.tick(300);
    expect(silences()).toHaveLength(1);
    expect(s.log).not.toContain('hangup c1');
  });

  it('does not hang up on a speak.ended that lands while the goodbye prompt is being sent', async () => {
    await s.tick(s.cfg.idleMs + 1000);
    s.reply('Still there?');
    await s.tick();
    await s.spoke();
    s.axo.onSend = async () => s.evt('call.speak.ended', { call_control_id: 'c1' });
    await s.tick(60_000);
    expect(silences()).toHaveLength(2);
    expect(s.log).not.toContain('hangup c1');
  });

  it('joins a weak-signal phrase that Flux split into one-word turns', async () => {
    const f = setup();
    f.axo.stt = 'deepgram/flux';
    await f.pickUp();
    await f.spoke();
    f.working();
    await f.hear('Road.');
    await f.tick(700);
    await f.hear('hear me?');
    await f.tick(800);
    expect(f.sent.slice(1).map(x => x.text)).toEqual(['[Channel: Phone call] [From: Johan] Road. hear me?']);
  });

  it('ignores filler noises that carry no words', async () => {
    await s.hear('Um.');
    await s.hear('hmm');
    await s.tick(2000);
    expect(s.sent).toHaveLength(1);
  });
});

describe('lookups and fillers', () => {
  let s: S;
  beforeEach(async () => {
    s = setup();
    await s.pickUp();
  });
  const fillers = () => s.spoken().filter(t => s.cfg.language.strings.fillers.includes(t));

  it('lets a lookup finish when he says something while it runs', async () => {
    await s.say('check my tasks');
    s.axo.tool = true;
    await s.tick();
    await s.spoke();
    await s.hear('okay thanks');
    await s.tick(1200);
    expect(s.sent.at(-1)).toMatchObject({ text: '[Channel: Phone call] [From: Johan] okay thanks', delivery: 'steer' });
  });

  it('plays one filler per question even when his words arrive in pieces', async () => {
    await s.say('check my tasks');
    s.axo.tool = true;
    await s.tick();
    await s.spoke();
    await s.hear('for today please');
    await s.tick(1200);
    s.axo.tool = true;
    await s.tick(7000);
    expect(fillers()).toHaveLength(1);
  });

  it('plays no filler before a silence check-in', async () => {
    await s.spoke();
    s.axo.status = 'idle';
    await s.tick();
    await s.tick(s.cfg.idleMs + 1000);
    s.working();
    await s.tick(7000);
    expect(fillers()).toEqual([]);
  });
});

describe('call thread archiving', () => {
  it('waits for a call thread that is still busy before archiving it', async () => {
    const s = setup();
    await s.pickUp();
    await s.say('call me in ten minutes');
    s.reply('Will do. [Hang up]');
    await s.tick();
    await s.evt('call.speak.ended', { call_control_id: 'c1' });
    await s.evt('call.hangup', { call_control_id: 'c1', hangup_source: 'callee' });
    await s.tick(RESUME_MS + 1000);
    s.axo.threadStatus = 'waiting';
    await s.tick(181_000);
    expect(s.log).not.toContain('archive jam_call');
    s.axo.threadStatus = 'idle';
    await s.tick(600_000);
    expect(s.log).toContain('archive jam_call');
  });
});

describe('outbound when he does not pick up', () => {
  it('places nothing in a thread when the call is never answered', async () => {
    const s = setup();
    await s.bridge.placeOutbound('Build failed', true);
    await s.evt('call.hangup', { call_control_id: 'out-1', hangup_cause: 'timeout', hangup_source: 'unknown' });
    expect(s.sent).toEqual([]);
    expect(s.store.listCalls()).toEqual([]);
  });

  it('leaves the alert on voicemail instead of talking to the greeting', async () => {
    const s = setup();
    await s.evt('call.answered', { call_control_id: 'o1', to: ALLOWED, client_state: encodeState({ k: 'out', text: 'The backup failed.', listen: true }) });
    await s.hear("Hi, you've reached Johan. Please leave a message after the tone.", 'o1');
    await s.tick(1500);
    expect(s.sent).toEqual([]);
    expect(s.log).toContain('speak o1 The backup failed. {"end":true}');
  });

  it('speaks the alert alone, without a "You can reply now" tag', async () => {
    const s = setup();
    await s.evt('call.answered', { call_control_id: 'o1', to: ALLOWED, client_state: encodeState({ k: 'out', text: 'This is a test call after the update.', listen: true }) });
    expect(s.spoken()).toEqual(['This is a test call after the update.']);
  });
});
