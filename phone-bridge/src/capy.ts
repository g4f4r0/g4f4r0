import type { Config } from './config';

export interface CapyMessage {
  id: string;
  source: 'user' | 'assistant' | 'tool';
  text: string;
}

export interface CapyApi {
  send(text: string, clientKey: string): Promise<string>;
  listAfter(afterId: string): Promise<{ items: CapyMessage[]; cursor: string | null }>;
  status(): Promise<string>;
}

export function createCapy(apiKey: string, cfg: Config, delivery: string, fetcher: typeof fetch = fetch): CapyApi {
  const call = async (path: string, init?: RequestInit): Promise<any> => {
    const res = await fetcher(`${cfg.capyBase}/threads/${cfg.threadId}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    });
    if (!res.ok) throw new Error(`capy ${path || '/'} failed with ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  };
  return {
    send: async (text, clientKey) =>
      (await call('/message', { method: 'POST', body: JSON.stringify({ text, delivery, clientKey }) })).id,
    listAfter: async afterId => {
      const page = await call(`/messages?after=${encodeURIComponent(afterId)}&limit=50`);
      return { items: page.items, cursor: page.cursor };
    },
    status: async () => (await call('')).status,
  };
}
