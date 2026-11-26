import { DurableObject } from 'cloudflare:workers';
import { Bridge, type CallState, type Store, type TelnyxEvent } from './engine';
import { createCapy } from './capy';
import { createTelnyx } from './telnyx';
import { parseConfig, type Env } from './config';
import { bearerMatches } from './guards';
import { verifyTelnyxSignature } from './verify';

const MAX_ALERT_CHARS = 1000;

export class PhoneBridge extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS outbound_counts (day TEXT PRIMARY KEY, n INTEGER NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, state TEXT NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL);',
    );
  }

  private store(): Store {
    const sql = this.sql;
    return {
      count: day => Number(sql.exec('SELECT n FROM outbound_counts WHERE day = ?', day).toArray()[0]?.n ?? 0),
      increment: day =>
        void sql.exec('INSERT INTO outbound_counts (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1', day),
      getCall: id => {
        const row = sql.exec('SELECT state FROM calls WHERE id = ?', id).toArray()[0];
        return row ? (JSON.parse(row.state as string) as CallState) : undefined;
      },
      putCall: s => void sql.exec('INSERT OR REPLACE INTO calls (id, state) VALUES (?, ?)', s.id, JSON.stringify(s)),
      deleteCall: id => void sql.exec('DELETE FROM calls WHERE id = ?', id),
      listCalls: () => sql.exec('SELECT state FROM calls').toArray().map(r => JSON.parse(r.state as string) as CallState),
      markSeen: (id, now) => {
        sql.exec('DELETE FROM seen WHERE at < ?', now - 3_600_000);
        if (sql.exec('SELECT 1 FROM seen WHERE id = ?', id).toArray().length) return false;
        sql.exec('INSERT INTO seen (id, at) VALUES (?, ?)', id, now);
        return true;
      },
    };
  }

  private bridge(): Bridge {
    const cfg = parseConfig(this.env);
    return new Bridge({
      cfg,
      telnyx: createTelnyx(this.env.TELNYX_API_KEY, cfg),
      capy: createCapy(this.env.CAPY_API_KEY, cfg, this.env.CAPY_DELIVERY ?? 'interrupt'),
      store: this.store(),
      now: () => Date.now(),
      setAlarm: async at => (at === null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(at)),
      log: m => console.log(m),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const bridge = this.bridge();
    if (url.pathname === '/event') {
      try {
        await bridge.handleEvent((await request.json()) as TelnyxEvent);
      } catch (err) {
        console.log(`event handler failed: ${(err as Error).message}`);
      }
      return new Response('ok');
    }
    if (url.pathname === '/call') {
      const { text, listen } = (await request.json()) as { text: string; listen: boolean };
      const result = await bridge.placeOutbound(text, listen);
      if (result.ok) return Response.json({ status: 'calling' }, { status: 202 });
      return Response.json({ error: result.reason === 'cap' ? 'daily outbound call limit reached' : 'call failed' }, {
        status: result.reason === 'cap' ? 429 : 502,
      });
    }
    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.bridge().tick();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const stub = env.BRIDGE.get(env.BRIDGE.idFromName('main'));

    if (request.method === 'POST' && url.pathname === '/telnyx/webhook') {
      const raw = await request.text();
      const ok = await verifyTelnyxSignature(
        raw,
        request.headers.get('telnyx-signature-ed25519'),
        request.headers.get('telnyx-timestamp'),
        env.TELNYX_PUBLIC_KEY,
      );
      if (!ok) return new Response('invalid signature', { status: 401 });
      await stub.fetch('https://bridge/event', { method: 'POST', body: raw });
      return new Response('ok');
    }

    if (request.method === 'POST' && url.pathname === '/call') {
      if (!(await bearerMatches(request.headers.get('authorization'), env.OUTBOUND_TOKEN))) {
        return new Response('unauthorized', { status: 401 });
      }
      let body: { text?: unknown; listen?: unknown };
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: 'invalid JSON' }, { status: 400 });
      }
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > MAX_ALERT_CHARS) {
        return Response.json({ error: `text is required and must be at most ${MAX_ALERT_CHARS} characters` }, { status: 400 });
      }
      return stub.fetch('https://bridge/call', { method: 'POST', body: JSON.stringify({ text, listen: body.listen === true }) });
    }

    return new Response('phone-bridge', { status: 404 });
  },
};
