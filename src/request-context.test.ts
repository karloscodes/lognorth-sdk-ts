import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import LogNorth from './index.js';
import { middleware } from './express.js';
import { TestServer } from './test-server.js';

describe('request context', () => {
  const server = new TestServer();

  before(() => server.start());
  after(() => server.stop());

  beforeEach(() => {
    server.requests = [];
    LogNorth.config(server.url, 'test', { environment: 'production', release: 'a1b2c3d' });
  });

  // What the server stored, without the "Release … started" events.
  const stored = () => server.stored.filter(e => !/^Release .+ started$/.test(e.message));

  // Runs one request through the Express middleware. The handler runs inside
  // the request, as next() does in an app.
  function request(path: string, status: number, handler: () => void = () => {}) {
    const req = { method: 'GET', path, headers: { 'user-agent': 'Mozilla/5.0' }, route: { path } };
    const res = Object.assign(new EventEmitter(), { statusCode: status, setHeader: mock.fn() });

    middleware()(req as any, res as any, () => handler());
    res.emit('finish');
  }

  it('puts the user a handler names on the request event and on its errors', async () => {
    request('/account', 500, () => {
      LogNorth.setUser(42);
      LogNorth.error('charge failed', new Error('card declined'));
    });

    await LogNorth.flush();

    const [error, req] = stored();
    assert.strictEqual(error.context?.user, '42');
    assert.strictEqual(req.context?.user, '42');
  });

  it('puts the user agent on a failed request only', async () => {
    request('/ok', 200);
    request('/broken', 500);

    await LogNorth.flush();

    const [ok, broken] = stored();
    assert.strictEqual(ok.context?.user_agent, undefined);
    assert.strictEqual(broken.context?.user_agent, 'Mozilla/5.0');
  });

  it('puts the release on errors and not on other events', async () => {
    LogNorth.log('signed up');
    LogNorth.error('charge failed', new Error('card declined'));

    await LogNorth.flush();

    const [log, error] = stored();
    assert.strictEqual(log.context?.release, undefined);
    assert.strictEqual(error.context?.release, 'a1b2c3d');
  });

  it('reads the release from the environment', async () => {
    process.env.KAMAL_VERSION = 'f00ba44';
    LogNorth.config(server.url, 'test', { environment: 'production' });

    LogNorth.error('charge failed', new Error('card declined'));
    await LogNorth.flush();
    delete process.env.KAMAL_VERSION;

    assert.strictEqual(stored()[0].context?.release, 'f00ba44');
  });

  it('says once that the release started', async () => {
    LogNorth.config(server.url, 'test', { environment: 'production', release: 'c0ffee1' });
    LogNorth.config(server.url, 'test', { environment: 'production', release: 'c0ffee1' });

    await LogNorth.flush();

    const starts = server.stored.filter(e => e.message === 'Release c0ffee1 started');
    assert.strictEqual(starts.length, 1);
    assert.strictEqual(starts[0].context?.release, 'c0ffee1');
  });

  it('ignores setUser outside a request', async () => {
    LogNorth.setUser(42);
    LogNorth.log('signed up');

    await LogNorth.flush();

    assert.strictEqual(stored()[0].context?.user, undefined);
  });
});
