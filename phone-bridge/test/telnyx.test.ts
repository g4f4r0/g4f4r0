import { describe, expect, it } from 'vitest';
import { createTelnyx } from '../src/telnyx';
import { parseConfig, TELNYX_STT_KEYTERMS, type Env } from '../src/config';

function capture(env: Partial<Env> = {}, failures = 0) {
  const requests: { url: string; body: any }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    if (failures > 0 && failures--) return new Response('{"errors":[]}', { status: 422 });
    return new Response('{"data":{"result":"ok"}}');
  }) as unknown as typeof fetch;
  const cfg = parseConfig({ CALLER_PHONE_NUMBER: '+1', TELNYX_PHONE_NUMBER: '+2', TELNYX_CONNECTION_ID: 'c', CAPY_PROJECT_ID: 'p', CAPY_CAPTAIN_ID: 't', ...env } as Env);
  return { telnyx: createTelnyx('key', cfg, fetcher), requests };
}

describe('telnyx transcription_start', () => {
  it('starts Deepgram Flux for built-in end of turn detection', async () => {
    const { telnyx, requests } = capture();
    expect(await telnyx.startTranscription('v3:abc')).toBe('deepgram/flux');
    expect(requests[0].body).toEqual({
      transcription_engine: 'Deepgram',
      transcription_engine_config: {
        transcription_engine: 'Deepgram',
        transcription_model: 'deepgram/flux',
        language: 'en',
        interim_results: true,
        keyterms: TELNYX_STT_KEYTERMS,
      },
      transcription_tracks: 'inbound',
    });
  });

  it('falls back to Nova-3 when Telnyx rejects Flux', async () => {
    const { telnyx, requests } = capture(undefined, 1);
    expect(await telnyx.startTranscription('v3:abc')).toBe('deepgram/nova-3');
    requests.shift();
    expect(requests[0].url).toBe('https://api.telnyx.com/v2/calls/v3%3Aabc/actions/transcription_start');
    expect(requests[0].body).toEqual({
      transcription_engine: 'Deepgram',
      transcription_engine_config: {
        transcription_engine: 'Deepgram',
        transcription_model: 'deepgram/nova-3',
        language: 'en',
        utterance_end_ms: 800,
        interim_results: true,
        keyterms: TELNYX_STT_KEYTERMS,
      },
      transcription_tracks: 'inbound',
    });
  });
});
