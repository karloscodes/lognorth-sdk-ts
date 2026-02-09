import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { createLogger } from './index.js';
import { middleware } from './express.js';

describe('express middleware', () => {
  let fetchCalls: { body: unknown }[] = [];

  beforeEach(() => {
    fetchCalls = [];
    // @ts-expect-error - mocking global fetch
    global.fetch = mock.fn(async (_url: string, options: { body: string }) => {
      fetchCalls.push({ body: JSON.parse(options.body) });
      return { ok: true };
    });
  });

  function createMockReqRes(method: string, path: string, statusCode: number) {
    const req = { method, path };
    const res = Object.assign(new EventEmitter(), { statusCode });
    return { req, res };
  }

  it('logs request on response finish', async () => {
    const log = createLogger({ apiKey: 'test', endpoint: 'https://test.com' });
    const mw = middleware(log);
    const { req, res } = createMockReqRes('GET', '/users', 200);
    const next = mock.fn();

    mw(req as any, res as any, next);
    assert.strictEqual(next.mock.calls.length, 1);

    res.emit('finish');
    await log.flush();

    const body = fetchCalls[0].body as { events: { message: string; context: Record<string, unknown> }[] };
    assert.strictEqual(body.events[0].message, 'GET /users → 200');
    assert.strictEqual(body.events[0].context.status, 200);
    assert.strictEqual(body.events[0].context.method, 'GET');
    assert.strictEqual(body.events[0].context.path, '/users');
    assert.ok(body.events[0].context.duration_ms !== undefined);
  });

  it('marks 500+ as error', async () => {
    const log = createLogger({ apiKey: 'test', endpoint: 'https://test.com' });
    const mw = middleware(log);
    const { req, res } = createMockReqRes('POST', '/checkout', 500);
    const next = mock.fn();

    mw(req as any, res as any, next);
    res.emit('finish');
    await log.flush();

    const body = fetchCalls[0].body as { events: { context: Record<string, unknown> }[] };
    assert.strictEqual(body.events[0].context.error, 'HTTP 500');
  });

  it('does not add error field for 4xx', async () => {
    const log = createLogger({ apiKey: 'test', endpoint: 'https://test.com' });
    const mw = middleware(log);
    const { req, res } = createMockReqRes('GET', '/missing', 404);
    const next = mock.fn();

    mw(req as any, res as any, next);
    res.emit('finish');
    await log.flush();

    const body = fetchCalls[0].body as { events: { context: Record<string, unknown> }[] };
    assert.strictEqual(body.events[0].context.error, undefined);
  });
});
