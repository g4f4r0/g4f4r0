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

export interface CapyApi {
  createThread(message: string, requestId: string, title: string): Promise<string>;
  send(threadId: string, text: string, clientKey: string, delivery?: 'interrupt' | 'queue'): Promise<string>;
  readReplies(threadId: string, afterId: string, windowMs: number, wake?: AbortSignal): Promise<ReplyWindow>;
  archive(threadId: string): Promise<void>;
}

const BATCH_MS = 150;
const SEND_TIMEOUT_MS = 3000;
const CREATE_TIMEOUT_MS = 8000;

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
  const url = (threadId: string, path: string) => `${cfg.capyBase}/threads/${threadId}${path}`;
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  const post = async (path: string, body: object, timeoutMs = SEND_TIMEOUT_MS): Promise<any> => {
    const once = () => fetcher(path, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    let res = await once().catch(() => null);
    if (!res || res.status >= 500 || res.status === 429) res = await once();
    if (!res.ok) throw new Error(`capy ${path.slice(cfg.capyBase.length)} failed with ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  };

  return {
    createThread: async (message, requestId, title) => {
      const thread = await post(
        `${cfg.capyBase}/threads`,
        {
          requestId,
          projectId: cfg.projectId,
          captainId: cfg.captainId,
          title,
          message,
          model: { modelId: cfg.callModel, reasoningMode: cfg.callReasoning },
          machineSize: 'small',
        },
        CREATE_TIMEOUT_MS,
      );
      return (thread as { id: string }).id;
    },

    send: async (threadId, text, clientKey, delivery = 'interrupt') =>
      ((await post(url(threadId, '/message'), { text, delivery, clientKey })) as { id: string }).id,

    archive: async threadId => void (await post(url(threadId, '/archive'), {})),

    readReplies: async (threadId, afterId, windowMs, wake) => {
      const result: ReplyWindow = { items: [], live: [], cursor: afterId, status: null, worked: false, toolStarted: false };
      const abort = new AbortController();
      wake?.addEventListener('abort', () => abort.abort());
      let timer = setTimeout(() => abort.abort(), windowMs);
      const soon = () => {
        clearTimeout(timer);
        timer = setTimeout(() => abort.abort(), BATCH_MS);
      };
      try {
        const res = await fetcher(url(threadId, afterId ? `/stream?after=${encodeURIComponent(afterId)}` : '/stream'), {
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
