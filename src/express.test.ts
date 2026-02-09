import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';

describe('express middleware', () => {
  let fetchCalls: { body: unknown }[] = [];
  let middleware: typeof import('./express.js').middleware;
  let config: typeof import('./index.js').config;
  let flush: typeof import('./index.js').flush;

  beforeEach(async () => {
    fetchCalls = [];
    global.fetch = mock.fn(async (_url: string, options: { body: string }) => {
      fetchCalls.push({ body: JSON.parse(options.body) });
      return { ok: true };
    }) as unknown as typeof fetch;

    const mod = await import('./index.js');
    const expressMod = await import('./express.js');
    middleware = expressMod.middleware;
    config = mod.config;
    flush = mod.flush;
    config({ apiKey: 'test', endpoint: 'https://test.com' });
  });

  function createMockReqRes(method: string, path: string, statusCode: number) {
    const req = { method, path };
    const res = Object.assign(new EventEmitter(), { statusCode });
    return { req, res };
  }

  it('logs request on response finish', async () => {
    const mw = middleware();
    const { req, res } = createMockReqRes('GET', '/users', 200);
    const next = mock.fn();

    mw(req as any, res as any, next);
    assert.strictEqual(next.mock.calls.length, 1);

    res.emit('finish');
    await flush();

    const body = fetchCalls[0].body as { events: { message: string; context: Record<string, unknown> }[] };
    assert.strictEqual(body.events[0].message, 'GET /users → 200');
    assert.strictEqual(body.events[0].context.status, 200);
  });
});
