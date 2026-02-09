import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { createLogger } from './index.js';

describe('createLogger', () => {
  let fetchCalls: { url: string; body: unknown }[] = [];
  let fetchFn: ReturnType<typeof mock.fn>;

  beforeEach(() => {
    fetchCalls = [];
    fetchFn = mock.fn(async (url: string, options: { body: string }) => {
      fetchCalls.push({ url, body: JSON.parse(options.body) });
      return { ok: true };
    });
    // @ts-expect-error - mocking global fetch
    global.fetch = fetchFn;
  });

  it('creates a logger function', () => {
    const log = createLogger({ apiKey: 'test-key', endpoint: 'https://logs.test.com' });

    assert.strictEqual(typeof log, 'function');
    assert.strictEqual(typeof log.error, 'function');
    assert.strictEqual(typeof log.flush, 'function');
  });

  it('buffers regular events until flush', async () => {
    const log = createLogger({ apiKey: 'test-key', endpoint: 'https://logs.test.com' });

    log('Event 1', { user: 123 });
    log('Event 2', { user: 456 });

    assert.strictEqual(fetchCalls.length, 0); // Not sent yet

    await log.flush();

    assert.strictEqual(fetchCalls.length, 1);
    const body = fetchCalls[0].body as { events: { message: string }[] };
    assert.strictEqual(body.events.length, 2);
  });

  it('sends errors immediately', async () => {
    const log = createLogger({ apiKey: 'test-key', endpoint: 'https://logs.test.com' });
    const err = new TypeError('Cannot read property');

    log.error('Something failed', { error: err });

    // Wait for async send
    await new Promise(r => setTimeout(r, 10));

    assert.strictEqual(fetchCalls.length, 1);
    const body = fetchCalls[0].body as { events: { error_type: string }[] };
    assert.strictEqual(body.events[0].error_type, 'TypeError');
  });

  it('retries errors up to 3 times with exponential backoff', async () => {
    let attempts = 0;
    // @ts-expect-error - mocking global fetch
    global.fetch = mock.fn(async () => {
      attempts++;
      if (attempts < 4) throw new Error('Network error');
      return { ok: true };
    });

    const log = createLogger({ apiKey: 'test-key', endpoint: 'https://logs.test.com' });
    const err = new Error('Test error');

    log.error('Failed', { error: err });

    // Wait for exponential backoff: 1s + 2s + 4s = 7s + buffer
    await new Promise(r => setTimeout(r, 7500));

    assert.strictEqual(attempts, 4); // Initial + 3 retries
  });

  it('retries regular events once', async () => {
    let attempts = 0;
    global.fetch = mock.fn(async () => {
      attempts++;
      throw new Error('Network error');
    }) as typeof fetch;

    const log = createLogger({ apiKey: 'test-key', endpoint: 'https://logs.test.com' });
    log('Regular event');
    await log.flush();

    // Wait for retry
    await new Promise(r => setTimeout(r, 1500));

    assert.strictEqual(attempts, 2); // Initial + 1 retry
  });

  it('flushes when batch size reached', async () => {
    const log = createLogger({ apiKey: 'test-key', endpoint: 'https://logs.test.com', batchSize: 2 });

    log('Event 1');
    assert.strictEqual(fetchCalls.length, 0);

    log('Event 2');
    await new Promise(r => setTimeout(r, 10));

    assert.strictEqual(fetchCalls.length, 1);
  });

  it('includes context in events', async () => {
    const log = createLogger({ apiKey: 'test-key', endpoint: 'https://logs.test.com' });

    log('User action', { user_id: 42, action: 'login' });
    await log.flush();

    const body = fetchCalls[0].body as { events: { context: Record<string, unknown> }[] };
    assert.strictEqual(body.events[0].context?.user_id, 42);
  });

  it('parses error stack for location', async () => {
    const log = createLogger({ apiKey: 'test-key', endpoint: 'https://logs.test.com' });
    const err = new TypeError('Cannot read property');

    log.error('Something failed', { error: err, request_id: 'req-123' });
    await new Promise(r => setTimeout(r, 10));

    const body = fetchCalls[0].body as { events: { error_type: string; error_location: string; context: Record<string, unknown> }[] };
    assert.strictEqual(body.events[0].error_type, 'TypeError');
    assert.ok(body.events[0].error_location); // Has location from stack
    assert.strictEqual(body.events[0].context?.error, 'Cannot read property');
  });

  it('sends auth header', async () => {
    let capturedHeaders: Record<string, string> = {};
    // @ts-expect-error - mocking global fetch
    global.fetch = mock.fn(async (_url: string, options: { headers: Record<string, string> }) => {
      capturedHeaders = options.headers;
      return { ok: true };
    });

    const log = createLogger({ apiKey: 'my-secret-key', endpoint: 'https://logs.test.com' });
    log('Test');
    await log.flush();

    assert.strictEqual(capturedHeaders['Authorization'], 'Bearer my-secret-key');
  });

  it('does nothing on empty flush', async () => {
    const log = createLogger({ apiKey: 'test-key', endpoint: 'https://logs.test.com' });
    await log.flush();
    assert.strictEqual(fetchCalls.length, 0);
  });

  it('retries on 429 (rate limit) and 503 (server busy)', async () => {
    let attempts = 0;
    // @ts-expect-error - mocking global fetch
    global.fetch = mock.fn(async () => {
      attempts++;
      if (attempts === 1) return { ok: false, status: 429 };
      if (attempts === 2) return { ok: false, status: 503 };
      return { ok: true };
    });

    const log = createLogger({ apiKey: 'test-key', endpoint: 'https://logs.test.com' });
    log.error('Critical error', { error: new Error('test') });

    // Wait for exponential backoff: 1s + 2s = 3s + buffer
    await new Promise(r => setTimeout(r, 3500));

    assert.strictEqual(attempts, 3); // 429 -> 503 -> success
  });

  it('drops oldest regular logs when buffer is full', async () => {
    const log = createLogger({
      apiKey: 'test-key',
      endpoint: 'https://logs.test.com',
      maxBufferSize: 3,
      flushInterval: 60000, // Don't auto-flush
    });

    log('Event 1');
    log('Event 2');
    log('Event 3');
    log('Event 4'); // Should drop Event 1

    await log.flush();

    const body = fetchCalls[0].body as { events: { message: string }[] };
    assert.strictEqual(body.events.length, 3);
    assert.strictEqual(body.events[0].message, 'Event 2'); // Event 1 was dropped
    assert.strictEqual(body.events[2].message, 'Event 4');
  });

  it('errors bypass buffer entirely (sent immediately)', async () => {
    const log = createLogger({
      apiKey: 'test-key',
      endpoint: 'https://logs.test.com',
      maxBufferSize: 2,
      flushInterval: 60000,
    });

    log('Regular 1');
    log('Regular 2');
    log.error('Error 1', { error: new Error('critical') });

    await new Promise(r => setTimeout(r, 10)); // Let error send

    // Error was sent immediately (separate from buffer)
    assert.strictEqual(fetchCalls.length, 1);
    const errorBody = fetchCalls[0].body as { events: { message: string }[] };
    assert.strictEqual(errorBody.events[0].message, 'Error 1');

    // Buffer still has regular events
    await log.flush();
    assert.strictEqual(fetchCalls.length, 2);
  });
});
