import type { Config } from './config';

export interface TelnyxApi {
  answer(callControlId: string, clientState: object): Promise<void>;
  reject(callControlId: string): Promise<void>;
  speak(callControlId: string, text: string, clientState?: object): Promise<void>;
  stopSpeaking(callControlId: string): Promise<void>;
  startTranscription(callControlId: string): Promise<void>;
  hangup(callControlId: string): Promise<void>;
  dial(clientState: object): Promise<string>;
}

export const encodeState = (state: object): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

export function decodeState(raw: string | null | undefined): Record<string, any> | null {
  if (!raw) return null;
  try {
    const bin = atob(raw);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function createTelnyx(apiKey: string, cfg: Config, fetcher: typeof fetch = fetch): TelnyxApi {
  const post = async (path: string, body: object): Promise<any> => {
    const res = await fetcher(`https://api.telnyx.com/v2${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`telnyx ${path} failed with ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  };
  const action = (id: string, name: string, body: object = {}) =>
    post(`/calls/${encodeURIComponent(id)}/actions/${name}`, body).then(() => undefined);

  return {
    answer: (id, state) => action(id, 'answer', { client_state: encodeState(state) }),
    reject: id => action(id, 'reject', { cause: 'CALL_REJECTED' }),
    speak: (id, text, state) =>
      action(id, 'speak', {
        payload: text,
        payload_type: 'text',
        voice: cfg.voice,
        language: cfg.language.speak,
        service_level: 'premium',
        ...(state ? { client_state: encodeState(state) } : {}),
      }),
    stopSpeaking: id => action(id, 'playback_stop', { stop: 'all' }),
    startTranscription: id =>
      action(id, 'transcription_start', {
        transcription_engine: cfg.sttEngine,
        transcription_engine_config: {
          transcription_engine: cfg.sttEngine,
          transcription_model: cfg.sttModel,
          language: cfg.language.stt,
          utterance_end_ms: cfg.utteranceEndMs,
          ...(cfg.keyterms.length ? { keyterms: cfg.keyterms } : {}),
        },
        transcription_tracks: 'inbound',
      }),
    hangup: id => action(id, 'hangup'),
    dial: async state => {
      const res = await post('/calls', {
        connection_id: cfg.connectionId,
        to: cfg.allowedCaller,
        from: cfg.telnyxNumber,
        client_state: encodeState(state),
        time_limit_secs: Math.ceil(cfg.maxCallMs / 1000),
        timeout_secs: 30,
      });
      return res.data.call_control_id as string;
    },
  };
}
