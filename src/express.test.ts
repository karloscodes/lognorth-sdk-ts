import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import LogNorth from './index.js';
import { middleware } from './express.js';

describe('express middleware', () => {
  let fetchCalls: { body: unknown }[] = [];

  beforeEach(() => {
    fetchCalls = [];
    global.fetch = mock.fn(async (_url: string, options: { body: string }) => {
      fetchCalls.push({ body: JSON.parse(options.body) });
      return { ok: true };
    }) as unknown as typeof fetch;

    LogNorth.config('https://test.com', 'test');
  });

  it('logs request on response finish', async () => {
    const mw = middleware();
    const req = { method: 'GET', path: '/users' };
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    const next = mock.fn();

    mw(req as any, res as any, next);
    res.emit('finish');
    await LogNorth.flush();

    const body = fetchCalls[0].body as { events: { message: string }[] };
    assert.strictEqual(body.events[0].message, 'GET /users → 200');
  });
});
