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
    const req = { method: 'GET', path: '/users', headers: {} };
    const res = Object.assign(new EventEmitter(), { statusCode: 200, setHeader: mock.fn() });
    const next = mock.fn();

    mw(req as any, res as any, next);
    res.emit('finish');
    await LogNorth.flush();

    const body = fetchCalls[0].body as { events: { message: string; trace_id?: string; duration_ms?: number; context: Record<string, unknown> }[] };
    assert.strictEqual(body.events[0].message, 'GET /users → 200');
    assert.ok(body.events[0].trace_id, 'expected trace_id on event');
    assert.strictEqual(typeof body.events[0].duration_ms, 'number');
    // duration_ms should NOT be in context
    assert.strictEqual(body.events[0].context?.duration_ms, undefined);
  });

  it('skips route miss 404', async () => {
    const mw = middleware();
    const req = { method: 'GET', path: '/.env', headers: {} };
    const res = Object.assign(new EventEmitter(), { statusCode: 404, setHeader: mock.fn() });
    const next = mock.fn();

    mw(req as any, res as any, next);
    res.emit('finish');
    await LogNorth.flush();

    assert.strictEqual(fetchCalls.length, 0);
  });

  it('tracks controller 404 when route matched', async () => {
    const mw = middleware();
    const req = { method: 'GET', path: '/users/999', headers: {}, route: { path: '/users/:id' } };
    const res = Object.assign(new EventEmitter(), { statusCode: 404, setHeader: mock.fn() });
    const next = mock.fn();

    mw(req as any, res as any, next);
    res.emit('finish');
    await LogNorth.flush();

    assert.strictEqual(fetchCalls.length, 1);
    const body = fetchCalls[0].body as { events: { message: string }[] };
    assert.strictEqual(body.events[0].message, 'GET /users/999 → 404');
  });

  it('stamps route pattern and handler name when express exposes them', async () => {
    const mw = middleware();
    const showUser = function showUser() {};
    const req = {
      method: 'GET',
      path: '/users/42',
      headers: {},
      route: { path: '/users/:id', stack: [{ handle: showUser }] },
    };
    const res = Object.assign(new EventEmitter(), { statusCode: 200, setHeader: mock.fn() });
    const next = mock.fn();

    mw(req as any, res as any, next);
    res.emit('finish');
    await LogNorth.flush();

    const body = fetchCalls[0].body as { events: { context: Record<string, unknown> }[] };
    assert.strictEqual(body.events[0].context?.route, '/users/:id');
    assert.strictEqual(body.events[0].context?.handler, 'showUser');
  });

  it('omits route/handler when express did not match a route layer', async () => {
    const mw = middleware();
    const req = { method: 'GET', path: '/', headers: {} };
    const res = Object.assign(new EventEmitter(), { statusCode: 200, setHeader: mock.fn() });
    const next = mock.fn();

    mw(req as any, res as any, next);
    res.emit('finish');
    await LogNorth.flush();

    const body = fetchCalls[0].body as { events: { context: Record<string, unknown> }[] };
    assert.strictEqual(body.events[0].context?.route, undefined);
    assert.strictEqual(body.events[0].context?.handler, undefined);
  });

  it('uses incoming X-Trace-ID header', async () => {
    const mw = middleware();
    const req = { method: 'POST', path: '/api', headers: { 'x-trace-id': 'incoming-123' } };
    const res = Object.assign(new EventEmitter(), { statusCode: 201, setHeader: mock.fn() });
    const next = mock.fn();

    mw(req as any, res as any, next);
    res.emit('finish');
    await LogNorth.flush();

    const body = fetchCalls[0].body as { events: { trace_id?: string }[] };
    assert.strictEqual(body.events[0].trace_id, 'incoming-123');
    assert.deepStrictEqual(res.setHeader.mock.calls[0].arguments, ['X-Trace-ID', 'incoming-123']);
  });
});
