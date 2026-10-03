import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import LogNorth from './index.js';
import { withTraceID } from './index.js';
import { TestServer } from './test-server.js';

describe('LogNorth', () => {
  const server = new TestServer();

  before(() => server.start());
  after(() => server.stop());

  beforeEach(() => {
    server.requests = [];
    LogNorth.config(server.url, 'test-key', { environment: 'production' });
  });

  it('batches regular logs until flush', async () => {
    LogNorth.log('Event 1', { user: 123 });
    LogNorth.log('Event 2', { user: 456 });

    assert.strictEqual(server.requests.length, 0);

    await LogNorth.flush();

    assert.strictEqual(server.requests.length, 1);
    assert.strictEqual(server.requests[0].events.length, 2);
  });

  it('sends errors immediately with structured fields in context', async () => {
    const err = new TypeError('Cannot read property');

    LogNorth.error('Something failed', err);

    await server.waitFor(() => server.stored.length === 1);
    const [event] = server.stored;
    assert.strictEqual(event.context?.error_class, 'TypeError');
    assert.strictEqual(event.context?.error, 'Cannot read property');
    assert.ok(event.context?.stack_trace);
  });

  it('includes context in logs', async () => {
    LogNorth.log('User action', { user_id: 42, action: 'login' });

    await LogNorth.flush();

    assert.strictEqual(server.stored[0].context?.user_id, 42);
  });

  it('includes context in errors', async () => {
    LogNorth.error('Failed', new Error('oops'), { order_id: 99 });

    await server.waitFor(() => server.stored.length === 1);

    assert.strictEqual(server.stored[0].context?.order_id, 99);
    assert.strictEqual(server.stored[0].context?.error, 'oops');
  });

  it('auto-attaches trace_id from AsyncLocalStorage', async () => {
    withTraceID('abc123', () => {
      LogNorth.log('traced event', { user_id: 1 });
    });

    await LogNorth.flush();

    assert.strictEqual(server.stored[0].trace_id, 'abc123');
  });

  it('sends auth header', async () => {
    LogNorth.log('Test');

    await LogNorth.flush();

    assert.strictEqual(server.requests[0].headers.authorization, 'Bearer test-key');
    assert.strictEqual(server.requests[0].headers['content-type'], 'application/json');
  });

  it('stamps environment on every event', async () => {
    LogNorth.config(server.url, 'test-key', { environment: 'staging' });

    LogNorth.log('hello');
    await LogNorth.flush();
    LogNorth.error('crash', new Error('boom'));
    await server.waitFor(() => server.stored.length === 2);

    assert.strictEqual(server.stored[0].context?.environment, 'staging');
    assert.strictEqual(server.stored[1].context?.environment, 'staging');
  });

  it('skips sending in test/development by default and sends in staging/production/preview', async () => {
    for (const env of ['test', 'development']) {
      server.requests = [];
      LogNorth.config(server.url, 'test-key', { environment: env });
      LogNorth.log('dropped');
      await LogNorth.flush();
      assert.strictEqual(server.requests.length, 0, `expected no send in ${env}`);
    }

    for (const env of ['staging', 'preview', 'qa', 'production']) {
      server.requests = [];
      LogNorth.config(server.url, 'test-key', { environment: env });
      LogNorth.log('sent');
      await LogNorth.flush();
      assert.strictEqual(server.requests.length, 1, `expected send in ${env}`);
    }
  });

  it('explicit enabled overrides the env-based default', async () => {
    LogNorth.config(server.url, 'test-key', { environment: 'development', enabled: true });

    LogNorth.log('forced on');
    await LogNorth.flush();

    assert.strictEqual(server.requests.length, 1);
  });
});
