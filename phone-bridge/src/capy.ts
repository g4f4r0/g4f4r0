import type { Config } from './config';

export interface CapyMessage {
  id: string;
  source: 'user' | 'assistant' | 'tool';
  text: string;
}

export interface ReplyWindow {
  items: CapyMessage[];
  cursor: string;
  status: string | null;
  worked: boolean;
}

export interface CapyApi {
  send(text: string, clientKey: string, delivery?: 'interrupt' | 'queue'): Promise<string>;
  readReplies(afterId: string, windowMs: number): Promise<ReplyWindow>;
}

const BATCH_MS = 150;

export function parseFrames(buffer: string): { frames: { id?: string; event: string; data: string }[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? '';
  const frames = parts.map(part => {
    const frame: { id?: string; event: string; data: string } = { event: 'message', data: '' };
    for (const line of part.split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i <= 0) continue;
      const field = line.slice(0, i);
      const value = line.slice(i + 1).replace(/^ /, '');
      if (field === 'id') frame.id = value;
      else if (field === 'event') frame.event = value;
      else if (field === 'data') frame.data += value;
    }
    return frame;
  });
  return { frames, rest };
}

export function createCapy(apiKey: string, cfg: Config, fetcher: typeof fetch = fetch): CapyApi {
  const url = (path: string) => `${cfg.capyBase}/threads/${cfg.threadId}${path}`;
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };

  return {
    send: async (text, clientKey, delivery = 'interrupt') => {
      const res = await fetcher(url('/message'), { method: 'POST', headers, body: JSON.stringify({ text, delivery, clientKey }) });
      if (!res.ok) throw new Error(`capy send failed with ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return ((await res.json()) as { id: string }).id;
    },

    readReplies: async (afterId, windowMs) => {
      const result: ReplyWindow = { items: [], cursor: afterId, status: null, worked: false };
      const abort = new AbortController();
      let timer = setTimeout(() => abort.abort(), windowMs);
      try {
        const res = await fetcher(url(`/stream?after=${encodeURIComponent(afterId)}`), {
          headers: { ...headers, accept: 'text/event-stream' },
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`capy stream failed with ${res.status}`);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const parsed = parseFrames(buffer + value);
          buffer = parsed.rest;
          for (const f of parsed.frames) {
            if (f.id) result.cursor = f.id;
            if (f.event === 'status') {
              result.status = JSON.parse(f.data).status ?? result.status;
              if (result.status === 'working') result.worked = true;
            }
            if (f.event === 'transcript') {
              const m = JSON.parse(f.data) as CapyMessage;
              if (m.source === 'assistant' && m.text?.trim()) {
                result.items.push(m);
                clearTimeout(timer);
                timer = setTimeout(() => abort.abort(), BATCH_MS);
              }
            }
            if (f.event === 'done' || f.event === 'error') return result;
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) throw err;
      } finally {
        clearTimeout(timer);
        abort.abort();
      }
      return result;
    },
  };
}
