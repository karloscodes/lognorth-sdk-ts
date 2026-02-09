import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import LogNorth from './index.js';

describe('LogNorth', () => {
  let fetchCalls: { url: string; body: unknown }[] = [];

  beforeEach(() => {
    fetchCalls = [];
    global.fetch = mock.fn(async (url: string, options: { body: string }) => {
      fetchCalls.push({ url, body: JSON.parse(options.body) });
      return { ok: true };
    }) as unknown as typeof fetch;

    LogNorth.config('https://logs.test.com', 'test-key');
  });

  it('batches regular logs until flush', async () => {
    LogNorth.log('Event 1', { user: 123 });
    LogNorth.log('Event 2', { user: 456 });

    assert.strictEqual(fetchCalls.length, 0);

    await LogNorth.flush();

    assert.strictEqual(fetchCalls.length, 1);
    const body = fetchCalls[0].body as { events: { message: string }[] };
    assert.strictEqual(body.events.length, 2);
  });

  it('sends errors immediately', async () => {
    const err = new TypeError('Cannot read property');
    LogNorth.error('Something failed', err);

    await new Promise(r => setTimeout(r, 10));

    assert.strictEqual(fetchCalls.length, 1);
    const body = fetchCalls[0].body as { events: { error_type: string }[] };
    assert.strictEqual(body.events[0].error_type, 'TypeError');
  });

  it('includes context in logs', async () => {
    LogNorth.log('User action', { user_id: 42, action: 'login' });
    await LogNorth.flush();

    const body = fetchCalls[0].body as { events: { context: Record<string, unknown> }[] };
    assert.strictEqual(body.events[0].context?.user_id, 42);
  });

  it('includes context in errors', async () => {
    LogNorth.error('Failed', new Error('oops'), { order_id: 99 });
    await new Promise(r => setTimeout(r, 10));

    const body = fetchCalls[0].body as { events: { context: Record<string, unknown> }[] };
    assert.strictEqual(body.events[0].context?.order_id, 99);
    assert.strictEqual(body.events[0].context?.error, 'oops');
  });

  it('sends auth header', async () => {
    let capturedHeaders: Record<string, string> = {};
    global.fetch = mock.fn(async (_url: string, options: { headers: Record<string, string> }) => {
      capturedHeaders = options.headers;
      return { ok: true };
    }) as unknown as typeof fetch;

    LogNorth.log('Test');
    await LogNorth.flush();

    assert.strictEqual(capturedHeaders['Authorization'], 'Bearer test-key');
  });
});
