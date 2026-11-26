export interface Env {
  BRIDGE: DurableObjectNamespace;
  TELNYX_API_KEY: string;
  TELNYX_PUBLIC_KEY: string;
  CAPY_API_KEY: string;
  ALLOWED_CALLER: string;
  OUTBOUND_TOKEN: string;
  TELNYX_NUMBER: string;
  TELNYX_CONNECTION_ID: string;
  CAPY_THREAD_ID: string;
  CAPY_API_BASE?: string;
  CALL_LANGUAGE?: string;
  CALL_MAX_SECONDS?: string;
  OUTBOUND_MAX_CALLS_PER_DAY?: string;
  HOLD_FILLER_AFTER_SECONDS?: string;
  HOLD_MUSIC_AFTER_SECONDS?: string;
  CALL_REPLY_TIMEOUT_SECONDS?: string;
  HOLD_MUSIC_URL?: string;
  CAPY_CALL_MODEL_ID?: string;
  CAPY_CALL_REASONING_MODE?: string;
  CAPY_CALL_FAST_MODE?: string;
  CAPY_DEFAULT_MODEL_ID?: string;
  CAPY_DEFAULT_REASONING_MODE?: string;
  CALL_MAX_SPOKEN_CHARS?: string;
  CALL_IDLE_SECONDS?: string;
  CALL_GREETING_TIMEOUT_SECONDS?: string;
  CALLER_NAME?: string;
  TELNYX_STT_KEYTERMS?: string;
  TELNYX_VOICE?: string;
  TELNYX_STT_ENGINE?: string;
  TELNYX_STT_MODEL?: string;
  TIMEZONE?: string;
}

export interface Strings {
  greeting: string;
  goodbye: string;
  fillers: string[];
  stillWorking: string;
  timeLimit: string;
  replyTimeout: string;
  failure: string;
  replyListen: string;
  truncated: string;
  link: string;
}

export interface Language {
  speak: string;
  stt: string;
  voice: string;
  name: string;
  strings: Strings;
}

export const LANGUAGES: Record<string, Language> = {
  en: {
    speak: 'en-US',
    stt: 'en',
    voice: 'Telnyx.Ultra.47c38ca4-5f35-497b-b1a3-415245fb35e1',
    name: 'English',
    strings: {
      greeting: 'Hey',
      goodbye: 'Talk soon. Bye.',
      fillers: ['Mm, let me see.', 'Okay, give me a sec.', 'Hmm, good question.', 'Sure, one sec.', 'Alright, let me check.'],
      stillWorking: 'Still working on it.',
      timeLimit: 'This call has reached its time limit. Goodbye.',
      replyTimeout: 'Axo has not answered yet. The answer will be in the thread. Goodbye.',
      failure: 'Something went wrong on my side. Please try again later. Goodbye.',
      replyListen: 'You can reply now.',
      truncated: 'The rest is in the thread.',
      link: 'a link',
    },
  },
  es: {
    speak: 'es-ES',
    stt: 'es',
    voice: 'AWS.Polly.Lucia-Neural',
    name: 'Spanish',
    strings: {
      greeting: 'Hola',
      goodbye: 'Hablamos. Adiós.',
      fillers: ['Mmm, a ver.', 'Vale, dame un segundo.', 'Buena pregunta.', 'Claro, un momento.', 'Vale, déjame mirar.'],
      stillWorking: 'Sigo trabajando en ello.',
      timeLimit: 'La llamada ha alcanzado su límite de tiempo. Adiós.',
      replyTimeout: 'Axo aún no ha respondido. La respuesta estará en el hilo. Adiós.',
      failure: 'Algo ha fallado por mi parte. Inténtalo de nuevo más tarde. Adiós.',
      replyListen: 'Ya puedes responder.',
      truncated: 'El resto está en el hilo.',
      link: 'un enlace',
    },
  },
};

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
  pollMs: number;
  streamWindowMs: number;
}

const int = (raw: string | undefined, fallback: number, name: string): number => {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
};

const REASONING = ['none', 'instant', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const reasoning = (raw: string | undefined, fallback: string, name: string): string => {
  const value = (raw ?? fallback).trim();
  if (!REASONING.includes(value)) throw new Error(`${name} must be one of ${REASONING.join(', ')}`);
  return value;
};

export function parseConfig(env: Env): Config {
  const language = LANGUAGES[(env.CALL_LANGUAGE ?? 'en').toLowerCase()];
  if (!language) throw new Error(`CALL_LANGUAGE must be one of: ${Object.keys(LANGUAGES).join(', ')}`);
  return {
    allowedCaller: env.ALLOWED_CALLER,
    telnyxNumber: env.TELNYX_NUMBER,
    connectionId: env.TELNYX_CONNECTION_ID,
    threadId: env.CAPY_THREAD_ID,
    capyBase: env.CAPY_API_BASE ?? 'https://api.capy.ai/api/v1',
    language,
    maxCallMs: int(env.CALL_MAX_SECONDS, 600, 'CALL_MAX_SECONDS') * 1000,
    maxOutboundPerDay: int(env.OUTBOUND_MAX_CALLS_PER_DAY, 10, 'OUTBOUND_MAX_CALLS_PER_DAY'),
    holdAfterMs: int(env.HOLD_FILLER_AFTER_SECONDS, 6, 'HOLD_FILLER_AFTER_SECONDS') * 1000,
    holdMusicAfterMs: int(env.HOLD_MUSIC_AFTER_SECONDS, 15, 'HOLD_MUSIC_AFTER_SECONDS') * 1000,
    replyTimeoutMs: int(env.CALL_REPLY_TIMEOUT_SECONDS, 300, 'CALL_REPLY_TIMEOUT_SECONDS') * 1000,
    holdMusicUrl: env.HOLD_MUSIC_URL ?? '',
    callModel: env.CAPY_CALL_MODEL_ID?.trim() || null,
    callFast: env.CAPY_CALL_FAST_MODE !== 'false',
    axoModel: env.CAPY_DEFAULT_MODEL_ID?.trim() || null,
    callReasoning: env.CAPY_CALL_REASONING_MODE === 'off' ? null : reasoning(env.CAPY_CALL_REASONING_MODE, 'low', 'CAPY_CALL_REASONING_MODE'),
    axoReasoning: reasoning(env.CAPY_DEFAULT_REASONING_MODE, 'high', 'CAPY_DEFAULT_REASONING_MODE'),
    maxSpokenChars: int(env.CALL_MAX_SPOKEN_CHARS, 700, 'CALL_MAX_SPOKEN_CHARS'),
    idleMs: int(env.CALL_IDLE_SECONDS, 20, 'CALL_IDLE_SECONDS') * 1000,
    greetingTimeoutMs: int(env.CALL_GREETING_TIMEOUT_SECONDS, 20, 'CALL_GREETING_TIMEOUT_SECONDS') * 1000,
    callerName: env.CALLER_NAME ?? 'Johan',
    keyterms: (env.TELNYX_STT_KEYTERMS ?? 'Axo,Capy,Johan,g4f4r0,Telnyx,Cloudflare,GitHub')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    utteranceEndMs: 800,
    voice: env.TELNYX_VOICE ?? language.voice,
    sttEngine: env.TELNYX_STT_ENGINE ?? 'Deepgram',
    sttModel: env.TELNYX_STT_MODEL ?? 'deepgram/nova-3',
    timezone: env.TIMEZONE ?? 'Europe/Madrid',
    debounceMs: 1000,
    pollMs: 250,
    streamWindowMs: 3000,
  };
}
