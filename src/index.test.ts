import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';

// Reset module state between tests
let log: typeof import('./index.js').default;
let config: typeof import('./index.js').config;
let flush: typeof import('./index.js').flush;

describe('lognorth', () => {
  let fetchCalls: { url: string; body: unknown }[] = [];

  beforeEach(async () => {
    fetchCalls = [];
    global.fetch = mock.fn(async (url: string, options: { body: string }) => {
      fetchCalls.push({ url, body: JSON.parse(options.body) });
      return { ok: true };
    }) as unknown as typeof fetch;

    // Re-import to reset state
    const mod = await import('./index.js');
    log = mod.default;
    config = mod.config;
    flush = mod.flush;
    config({ apiKey: 'test-key', endpoint: 'https://logs.test.com' });
  });

  it('batches regular events until flush', async () => {
    log('Event 1', { user: 123 });
    log('Event 2', { user: 456 });

    assert.strictEqual(fetchCalls.length, 0);

    await flush();

    assert.strictEqual(fetchCalls.length, 1);
    const body = fetchCalls[0].body as { events: { message: string }[] };
    assert.strictEqual(body.events.length, 2);
  });

  it('sends errors immediately', async () => {
    const err = new TypeError('Cannot read property');
    log.error('Something failed', { error: err });

    await new Promise(r => setTimeout(r, 10));

    assert.strictEqual(fetchCalls.length, 1);
    const body = fetchCalls[0].body as { events: { error_type: string }[] };
    assert.strictEqual(body.events[0].error_type, 'TypeError');
  });

  it('includes context in events', async () => {
    log('User action', { user_id: 42, action: 'login' });
    await flush();

    const body = fetchCalls[0].body as { events: { context: Record<string, unknown> }[] };
    assert.strictEqual(body.events[0].context?.user_id, 42);
  });

  it('sends auth header', async () => {
    let capturedHeaders: Record<string, string> = {};
    global.fetch = mock.fn(async (_url: string, options: { headers: Record<string, string> }) => {
      capturedHeaders = options.headers;
      return { ok: true };
    }) as unknown as typeof fetch;

    log('Test');
    await flush();

    assert.strictEqual(capturedHeaders['Authorization'], 'Bearer test-key');
  });

  it('does nothing on empty flush', async () => {
    await flush();
    assert.strictEqual(fetchCalls.length, 0);
  });
});
