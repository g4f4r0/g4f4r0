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
  LANGUAGE?: string;
  MAX_CALL_SECONDS?: string;
  MAX_OUTBOUND_PER_DAY?: string;
  HOLD_AFTER_SECONDS?: string;
  HOLD_MUSIC_AFTER_SECONDS?: string;
  REPLY_TIMEOUT_SECONDS?: string;
  HOLD_MUSIC_URL?: string;
  CALL_MODEL?: string;
  CALL_REASONING?: string;
  CALL_FAST?: string;
  AXO_MODEL?: string;
  AXO_REASONING?: string;
  MAX_SPOKEN_CHARS?: string;
  IDLE_SECONDS?: string;
  GREETING_TIMEOUT_SECONDS?: string;
  CALLER_NAME?: string;
  KEYTERMS?: string;
  VOICE?: string;
  STT_ENGINE?: string;
  STT_MODEL?: string;
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
  const language = LANGUAGES[(env.LANGUAGE ?? 'en').toLowerCase()];
  if (!language) throw new Error(`LANGUAGE must be one of: ${Object.keys(LANGUAGES).join(', ')}`);
  return {
    allowedCaller: env.ALLOWED_CALLER,
    telnyxNumber: env.TELNYX_NUMBER,
    connectionId: env.TELNYX_CONNECTION_ID,
    threadId: env.CAPY_THREAD_ID,
    capyBase: env.CAPY_API_BASE ?? 'https://api.capy.ai/api/v1',
    language,
    maxCallMs: int(env.MAX_CALL_SECONDS, 600, 'MAX_CALL_SECONDS') * 1000,
    maxOutboundPerDay: int(env.MAX_OUTBOUND_PER_DAY, 10, 'MAX_OUTBOUND_PER_DAY'),
    holdAfterMs: int(env.HOLD_AFTER_SECONDS, 6, 'HOLD_AFTER_SECONDS') * 1000,
    holdMusicAfterMs: int(env.HOLD_MUSIC_AFTER_SECONDS, 15, 'HOLD_MUSIC_AFTER_SECONDS') * 1000,
    replyTimeoutMs: int(env.REPLY_TIMEOUT_SECONDS, 300, 'REPLY_TIMEOUT_SECONDS') * 1000,
    holdMusicUrl: env.HOLD_MUSIC_URL ?? '',
    callModel: env.CALL_MODEL?.trim() || null,
    callFast: env.CALL_FAST !== 'false',
    axoModel: env.AXO_MODEL?.trim() || null,
    callReasoning: env.CALL_REASONING === 'off' ? null : reasoning(env.CALL_REASONING, 'low', 'CALL_REASONING'),
    axoReasoning: reasoning(env.AXO_REASONING, 'high', 'AXO_REASONING'),
    maxSpokenChars: int(env.MAX_SPOKEN_CHARS, 700, 'MAX_SPOKEN_CHARS'),
    idleMs: int(env.IDLE_SECONDS, 20, 'IDLE_SECONDS') * 1000,
    greetingTimeoutMs: int(env.GREETING_TIMEOUT_SECONDS, 20, 'GREETING_TIMEOUT_SECONDS') * 1000,
    callerName: env.CALLER_NAME ?? 'Johan',
    keyterms: (env.KEYTERMS ?? 'Axo,Capy,Johan,g4f4r0,Telnyx,Cloudflare,GitHub')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    utteranceEndMs: 800,
    voice: env.VOICE ?? language.voice,
    sttEngine: env.STT_ENGINE ?? 'Deepgram',
    sttModel: env.STT_MODEL ?? 'deepgram/nova-3',
    timezone: env.TIMEZONE ?? 'Europe/Madrid',
    debounceMs: 1000,
    pollMs: 250,
    streamWindowMs: 3000,
  };
}
