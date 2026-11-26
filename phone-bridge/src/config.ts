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
  CAPY_DELIVERY?: string;
  LANGUAGE?: string;
  MAX_CALL_SECONDS?: string;
  MAX_OUTBOUND_PER_DAY?: string;
  HOLD_AFTER_SECONDS?: string;
  REPLY_TIMEOUT_SECONDS?: string;
  MAX_SPOKEN_CHARS?: string;
  VOICE?: string;
  STT_ENGINE?: string;
  STT_MODEL?: string;
  TIMEZONE?: string;
}

export interface Strings {
  greeting: string;
  hold: string;
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
    voice: 'AWS.Polly.Joanna-Neural',
    name: 'English',
    strings: {
      greeting: 'Axo here. Go ahead.',
      hold: 'One moment, I am asking Axo.',
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
      greeting: 'Habla Axo. Dime.',
      hold: 'Un momento, se lo pregunto a Axo.',
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
  replyTimeoutMs: number;
  maxSpokenChars: number;
  voice: string;
  sttEngine: string;
  sttModel: string;
  timezone: string;
  debounceMs: number;
  pollMs: number;
}

const int = (raw: string | undefined, fallback: number, name: string): number => {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
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
    holdAfterMs: int(env.HOLD_AFTER_SECONDS, 8, 'HOLD_AFTER_SECONDS') * 1000,
    replyTimeoutMs: int(env.REPLY_TIMEOUT_SECONDS, 180, 'REPLY_TIMEOUT_SECONDS') * 1000,
    maxSpokenChars: int(env.MAX_SPOKEN_CHARS, 700, 'MAX_SPOKEN_CHARS'),
    voice: env.VOICE ?? language.voice,
    sttEngine: env.STT_ENGINE ?? 'Deepgram',
    sttModel: env.STT_MODEL ?? 'nova-3',
    timezone: env.TIMEZONE ?? 'Europe/Madrid',
    debounceMs: 1500,
    pollMs: 2000,
  };
}
