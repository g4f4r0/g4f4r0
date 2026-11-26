export const CALLER_NAME = 'Johan';
export const TIMEZONE = 'Europe/Madrid';
export const MAX_CALL_SECONDS = 600;
export const MAX_OUTBOUND_CALLS_PER_DAY = 10;
export const HOLD_MUSIC_URL = 'https://g4f4r0-axo.hellogafaro.workers.dev/hold.mp3';
export const CAPY_API_BASE = 'https://api.capy.ai/api/v1';
export const TELNYX_VOICE = 'Telnyx.Ultra.47c38ca4-5f35-497b-b1a3-415245fb35e1';
export const TELNYX_STT_ENGINE = 'Deepgram';
export const TELNYX_STT_MODEL = 'deepgram/nova-3';
export const TELNYX_STT_KEYTERMS = ['Axo', 'Capy', 'Johan', 'g4f4r0', 'Telnyx', 'Cloudflare', 'GitHub'];

export const STRINGS = {
  greeting: 'Hey',
  goodbye: 'Talk soon. Bye.',
  fillers: ['Mm, let me see.', 'Okay, give me a sec.', 'Hmm, good question.', 'Sure, one sec.', 'Alright, let me check.'],
  timeLimit: 'This call has reached its time limit. Goodbye.',
  replyTimeout: 'Axo has not answered yet. The answer will be in the thread. Goodbye.',
  failure: 'Something went wrong on my side. Please try again later. Goodbye.',
  replyListen: 'You can reply now.',
  truncated: 'The rest is in the thread.',
  link: 'a link',
};

export interface Env {
  BRIDGE: DurableObjectNamespace;
  TELNYX_API_KEY: string;
  TELNYX_PUBLIC_KEY: string;
  TELNYX_CONNECTION_ID: string;
  TELNYX_PHONE_NUMBER: string;
  CAPY_API_KEY: string;
  CAPY_THREAD_ID: string;
  CAPY_CALL_MODEL_ID?: string;
  CAPY_CALL_REASONING_MODE?: string;
  CAPY_CALL_FAST_MODE?: string;
  CAPY_DEFAULT_MODEL_ID?: string;
  CAPY_DEFAULT_REASONING_MODE?: string;
  CALLER_PHONE_NUMBER: string;
  OUTBOUND_TOKEN: string;
}

export type Strings = typeof STRINGS;

export interface Language {
  speak: string;
  stt: string;
  name: string;
  strings: Strings;
}

export interface Config {
  allowedCaller: string;
  telnyxNumber: string;
  connectionId: string;
  threadId: string;
  capyBase: string;
  language: Language;
  maxCallMs: number;
  maxOutboundPerDay: number;
  holdAfterMs: number;
  holdMusicAfterMs: number;
  replyTimeoutMs: number;
  holdMusicUrl: string;
  callModel: string | null;
  callReasoning: string | null;
  callFast: boolean;
  axoModel: string | null;
  axoReasoning: string;
  maxSpokenChars: number;
  idleMs: number;
  greetingTimeoutMs: number;
  callerName: string;
  keyterms: string[];
  utteranceEndMs: number;
  voice: string;
  sttEngine: string;
  sttModel: string;
  timezone: string;
  debounceMs: number;
  sentenceEndMs: number;
  pollMs: number;
  streamWindowMs: number;
}

const REASONING = ['none', 'instant', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const reasoning = (raw: string | undefined, fallback: string, name: string): string => {
  const value = (raw ?? fallback).trim();
  if (!REASONING.includes(value)) throw new Error(`${name} must be one of ${REASONING.join(', ')}`);
  return value;
};

export function parseConfig(env: Env): Config {
  return {
    allowedCaller: env.CALLER_PHONE_NUMBER,
    telnyxNumber: env.TELNYX_PHONE_NUMBER,
    connectionId: env.TELNYX_CONNECTION_ID,
    threadId: env.CAPY_THREAD_ID,
    capyBase: CAPY_API_BASE,
    language: { speak: 'en-US', stt: 'en', name: 'English', strings: STRINGS },
    maxCallMs: MAX_CALL_SECONDS * 1000,
    maxOutboundPerDay: MAX_OUTBOUND_CALLS_PER_DAY,
    holdAfterMs: 6000,
    holdMusicAfterMs: 15_000,
    replyTimeoutMs: 300_000,
    holdMusicUrl: HOLD_MUSIC_URL,
    callModel: env.CAPY_CALL_MODEL_ID?.trim() || null,
    callReasoning: env.CAPY_CALL_REASONING_MODE === 'off' ? null : reasoning(env.CAPY_CALL_REASONING_MODE, 'low', 'CAPY_CALL_REASONING_MODE'),
    callFast: env.CAPY_CALL_FAST_MODE !== 'false',
    axoModel: env.CAPY_DEFAULT_MODEL_ID?.trim() || null,
    axoReasoning: reasoning(env.CAPY_DEFAULT_REASONING_MODE, 'high', 'CAPY_DEFAULT_REASONING_MODE'),
    maxSpokenChars: 700,
    idleMs: 20_000,
    greetingTimeoutMs: 20_000,
    callerName: CALLER_NAME,
    keyterms: TELNYX_STT_KEYTERMS,
    utteranceEndMs: 800,
    voice: TELNYX_VOICE,
    sttEngine: TELNYX_STT_ENGINE,
    sttModel: TELNYX_STT_MODEL,
    timezone: TIMEZONE,
    debounceMs: 1200,
    sentenceEndMs: 400,
    pollMs: 250,
    streamWindowMs: 3000,
  };
}
