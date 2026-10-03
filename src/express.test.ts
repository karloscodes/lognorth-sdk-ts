import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import LogNorth from './index.js';
import { middleware } from './express.js';
import { TestServer } from './test-server.js';

describe('express middleware', () => {
  const server = new TestServer();

  before(() => server.start());
  after(() => server.stop());

  beforeEach(() => {
    server.requests = [];
    LogNorth.config(server.url, 'test', { environment: 'production' });
  });

  it('logs request on response finish', async () => {
    const mw = middleware();
    const req = { method: 'GET', path: '/users', headers: {} };
    const res = Object.assign(new EventEmitter(), { statusCode: 200, setHeader: mock.fn() });
    const next = mock.fn();

    mw(req as any, res as any, next);
    res.emit('finish');
    await LogNorth.flush();

    const [event] = server.stored;
    assert.strictEqual(event.message, 'GET /users → 200');
    assert.ok(event.trace_id, 'expected trace_id on event');
    assert.strictEqual(typeof event.duration_ms, 'number');
    // duration_ms should NOT be in context
    assert.strictEqual(event.context?.duration_ms, undefined);
  });

  it('skips route miss 404', async () => {
    const mw = middleware();
    const req = { method: 'GET', path: '/.env', headers: {} };
    const res = Object.assign(new EventEmitter(), { statusCode: 404, setHeader: mock.fn() });
    const next = mock.fn();

    mw(req as any, res as any, next);
    res.emit('finish');
    await LogNorth.flush();

    assert.strictEqual(server.requests.length, 0);
  });

  it('tracks controller 404 when route matched', async () => {
    const mw = middleware();
    const req = { method: 'GET', path: '/users/999', headers: {}, route: { path: '/users/:id' } };
    const res = Object.assign(new EventEmitter(), { statusCode: 404, setHeader: mock.fn() });
    const next = mock.fn();

    mw(req as any, res as any, next);
    res.emit('finish');
    await LogNorth.flush();

    assert.strictEqual(server.requests.length, 1);
    const [event] = server.stored;
    assert.strictEqual(event.message, 'GET /users/999 → 404');
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

    const [event] = server.stored;
    assert.strictEqual(event.context?.route, '/users/:id');
    assert.strictEqual(event.context?.handler, 'showUser');
  });

  it('omits route/handler when express did not match a route layer', async () => {
    const mw = middleware();
    const req = { method: 'GET', path: '/', headers: {} };
    const res = Object.assign(new EventEmitter(), { statusCode: 200, setHeader: mock.fn() });
    const next = mock.fn();

    mw(req as any, res as any, next);
    res.emit('finish');
    await LogNorth.flush();

    const [event] = server.stored;
    assert.strictEqual(event.context?.route, undefined);
    assert.strictEqual(event.context?.handler, undefined);
  });

  it('uses incoming X-Trace-ID header', async () => {
    const mw = middleware();
    const req = { method: 'POST', path: '/api', headers: { 'x-trace-id': 'incoming-123' } };
    const res = Object.assign(new EventEmitter(), { statusCode: 201, setHeader: mock.fn() });
    const next = mock.fn();

    mw(req as any, res as any, next);
    res.emit('finish');
    await LogNorth.flush();

    const [event] = server.stored;
    assert.strictEqual(event.trace_id, 'incoming-123');
    assert.deepStrictEqual(res.setHeader.mock.calls[0].arguments, ['X-Trace-ID', 'incoming-123']);
  });
});
