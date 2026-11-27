export const CALLER_NAME = 'Johan';
export const TIMEZONE = 'Europe/Madrid';
export const MAX_CALL_SECONDS = 600;
export const MAX_OUTBOUND_CALLS_PER_DAY = 10;
export const HOLD_MUSIC_URL = 'https://g4f4r0-axo.hellogafaro.workers.dev/hold.mp3';
export const CAPY_API_BASE = 'https://api.capy.ai/api/v1';
export const TELNYX_VOICE = 'Telnyx.Ultra.47c38ca4-5f35-497b-b1a3-415245fb35e1';
export const TELNYX_STT_ENGINE = 'Deepgram';
export const TELNYX_STT_MODEL = 'deepgram/flux';
export const TELNYX_STT_FALLBACK_MODEL = 'deepgram/nova-3';
export const TELNYX_STT_KEYTERMS = [
  'Axo', 'Capy', 'Johan', 'g4f4r0', 'Telnyx', 'Cloudflare', 'GitHub', 'Notion', 'Paper',
  'Otto', 'Ada', 'Opal', 'Belly', 'Timber', 'Sam', 'Astro', 'Carat', 'Genuins', 'Lulu', 'Momo', 'Crispin', 'Molly', 'Penny', 'Herald',
  'Jackfir', 'Facekit', 'Rebuy', 'Channable', 'Shopify', 'Klaviyo',
];

export const STRINGS = {
  greeting: 'Hey',
  goodbye: 'Talk soon. Bye.',
  fillers: ['One sec.', 'Let me look.', 'Hmm, let me see.'],
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
  CAPY_PROJECT_ID: string;
  CAPY_CAPTAIN_ID: string;
  CAPY_CALL_MODEL_ID?: string;
  CAPY_CALL_REASONING_MODE?: string;
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
  projectId: string;
  captainId: string;
  capyBase: string;
  language: Language;
  maxCallMs: number;
  maxOutboundPerDay: number;
  holdAfterMs: number;
  holdMusicAfterMs: number;
  replyTimeoutMs: number;
  holdMusicUrl: string;
  callModel: string;
  callReasoning: string;
  maxSpokenChars: number;
  idleMs: number;
  idleByeMs: number;
  greetingTimeoutMs: number;
  callerName: string;
  keyterms: string[];
  utteranceEndMs: number;
  voice: string;
  sttEngine: string;
  sttModel: string;
  sttFallbackModel: string;
  timezone: string;
  debounceMs: number;
  sentenceEndMs: number;
  fragmentMs: number;
  holdGraceMs: number;
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
    projectId: env.CAPY_PROJECT_ID,
    captainId: env.CAPY_CAPTAIN_ID,
    capyBase: CAPY_API_BASE,
    language: { speak: 'en-US', stt: 'en', name: 'English', strings: STRINGS },
    maxCallMs: MAX_CALL_SECONDS * 1000,
    maxOutboundPerDay: MAX_OUTBOUND_CALLS_PER_DAY,
    holdAfterMs: 6000,
    holdMusicAfterMs: 15_000,
    replyTimeoutMs: 300_000,
    holdMusicUrl: HOLD_MUSIC_URL,
    callModel: env.CAPY_CALL_MODEL_ID?.trim() || 'anthropic/claude-sonnet-5-5',
    callReasoning: reasoning(env.CAPY_CALL_REASONING_MODE, 'low', 'CAPY_CALL_REASONING_MODE'),
    maxSpokenChars: 700,
    idleMs: 40_000,
    idleByeMs: 30_000,
    greetingTimeoutMs: 20_000,
    callerName: CALLER_NAME,
    keyterms: TELNYX_STT_KEYTERMS,
    utteranceEndMs: 800,
    voice: TELNYX_VOICE,
    sttEngine: TELNYX_STT_ENGINE,
    sttModel: TELNYX_STT_MODEL,
    sttFallbackModel: TELNYX_STT_FALLBACK_MODEL,
    timezone: TIMEZONE,
    debounceMs: 1200,
    sentenceEndMs: 400,
    fragmentMs: 800,
    holdGraceMs: 4000,
    pollMs: 250,
    streamWindowMs: 3000,
  };
}
