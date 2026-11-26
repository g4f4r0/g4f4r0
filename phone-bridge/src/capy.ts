import type { Config } from './config';

export interface CapyMessage {
  id: string;
  source: 'user' | 'assistant' | 'tool';
  text: string;
  callId?: string;
}

export interface LiveReply {
  callId: string;
  text: string;
}

export interface ReplyWindow {
  items: CapyMessage[];
  live: LiveReply[];
  cursor: string;
  status: string | null;
  worked: boolean;
  toolStarted: boolean;
}

export interface ModelSelection {
  modelId: string;
  reasoningMode?: string;
  modes?: { fast?: boolean };
}

export interface Models {
  current: string | null;
  fast: string[];
}

export interface CapyApi {
  send(text: string, clientKey: string, delivery?: 'interrupt' | 'queue', model?: ModelSelection): Promise<string>;
  readModels(): Promise<Models>;
  readReplies(afterId: string, windowMs: number, wake?: AbortSignal): Promise<ReplyWindow>;
}

const BATCH_MS = 150;
const SEND_TIMEOUT_MS = 3000;

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
    send: async (text, clientKey, delivery = 'interrupt', model) => {
      const post = (withModel: boolean) =>
        fetcher(url('/message'), {
          method: 'POST',
          headers,
          body: JSON.stringify({ text, delivery, clientKey, ...(withModel && model ? { model } : {}) }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      let res = await post(true).catch(() => null);
      if (!res || res.status >= 500 || res.status === 429) res = await post(true);
      if (res.status === 400 && model) res = await post(false);
      if (!res.ok) throw new Error(`capy send failed with ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return ((await res.json()) as { id: string }).id;
    },

    readModels: async () => {
      const get = async (path: string) => {
        const res = await fetcher(path, { headers, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`capy ${path} failed with ${res.status}`);
        return res.json() as Promise<any>;
      };
      const [thread, models] = await Promise.all([get(url('')), get(`${cfg.capyBase}/models`)]);
      const list: any[] = Array.isArray(models) ? models : (models?.items ?? []);
      return {
        current: typeof thread?.lastModelId === 'string' ? thread.lastModelId : null,
        fast: list.filter(m => m?.fast === true && typeof m.id === 'string').map(m => m.id),
      };
    },

    readReplies: async (afterId, windowMs, wake) => {
      const result: ReplyWindow = { items: [], live: [], cursor: afterId, status: null, worked: false, toolStarted: false };
      const abort = new AbortController();
      wake?.addEventListener('abort', () => abort.abort());
      let timer = setTimeout(() => abort.abort(), windowMs);
      const soon = () => {
        clearTimeout(timer);
        timer = setTimeout(() => abort.abort(), BATCH_MS);
      };
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
              else if (result.items.length || result.live.length) return result;
            }
            if (f.event === 'assistant') {
              const frag = JSON.parse(f.data) as LiveReply;
              const known = result.live.find(l => l.callId === frag.callId);
              if (known) known.text += frag.text;
              else result.live.push({ callId: frag.callId, text: frag.text });
              soon();
            }
            if (f.event === 'tool_call') {
              result.toolStarted = true;
              soon();
            }
            if (f.event === 'transcript') {
              const m = JSON.parse(f.data) as CapyMessage;
              if (m.source === 'assistant' && m.text?.trim()) {
                result.items.push(m);
                soon();
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
