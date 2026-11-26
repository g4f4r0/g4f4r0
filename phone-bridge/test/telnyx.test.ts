import { describe, expect, it } from 'vitest';
import { createTelnyx } from '../src/telnyx';
import { parseConfig, type Env } from '../src/config';

function capture(env: Partial<Env> = {}) {
  const requests: { url: string; body: any }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    return new Response('{"data":{"result":"ok"}}');
  }) as unknown as typeof fetch;
  const cfg = parseConfig({ ALLOWED_CALLER: '+1', TELNYX_NUMBER: '+2', TELNYX_CONNECTION_ID: 'c', CAPY_THREAD_ID: 't', ...env } as Env);
  return { telnyx: createTelnyx('key', cfg, fetcher), requests };
}

describe('telnyx transcription_start', () => {
  it('uses the Deepgram Nova-3 model id Telnyx accepts', async () => {
    const { telnyx, requests } = capture();
    await telnyx.startTranscription('v3:abc');
    expect(requests[0].url).toBe('https://api.telnyx.com/v2/calls/v3%3Aabc/actions/transcription_start');
    expect(requests[0].body).toEqual({
      transcription_engine: 'Deepgram',
      transcription_engine_config: {
        transcription_engine: 'Deepgram',
        transcription_model: 'deepgram/nova-3',
        language: 'en',
        utterance_end_ms: 800,
        keyterms: ['Axo', 'Capy', 'Johan', 'g4f4r0', 'Telnyx', 'Cloudflare', 'GitHub'],
      },
      transcription_tracks: 'inbound',
    });
  });

  it('switches the recognition language with LANGUAGE', async () => {
    const { telnyx, requests } = capture({ LANGUAGE: 'es' });
    await telnyx.startTranscription('x');
    expect(requests[0].body.transcription_engine_config.language).toBe('es');
  });
});
