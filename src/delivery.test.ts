import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import LogNorth, { _settings, _reset } from './index.js';
import { TestServer } from './test-server.js';

const defaults = { ..._settings };

function logMany(count: number, prefix = 'event', context?: Record<string, unknown>): string[] {
  const messages: string[] = [];
  for (let i = 0; i < count; i++) {
    const message = `${prefix} ${i}`;
    LogNorth.log(message, context);
    messages.push(message);
  }
  return messages;
}

function messages(server: TestServer): string[] {
  return server.stored.map(e => e.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// A server that is down: it holds a free port and starts on it later.
async function downServer(): Promise<TestServer> {
  const server = new TestServer();
  await server.start();
  await server.stop();
  return server;
}

describe('delivery', () => {
  const server = new TestServer();

  before(async () => {
    Object.assign(_settings, {
      wakeMs: 50,
      backoffMs: 20,
      backoffMaxMs: 200,
      configBackoffMs: 50,
      configBackoffMaxMs: 200,
      requestTimeoutMs: 300,
      shutdownMs: 1000,
    });
    await server.start();
  });

  after(async () => {
    Object.assign(_settings, defaults);
    await server.stop();
  });

  beforeEach(() => {
    _reset();
    server.requests = [];
    server.attempts = 0;
    server.replies = [];
    server.answer = undefined;
    LogNorth.config(server.url, 'test-key', { environment: 'production' });
  });

  afterEach(async () => {
    server.replies = [];
    server.answer = undefined;
    LogNorth.config(server.url, 'test-key', { environment: 'production' });
    await LogNorth.flush();
    _reset();
  });

  describe('when the server asks to retry later', () => {
    it('resends the batch after Retry-After on 503 and it arrives once', async () => {
      server.replies = [{ status: 503, headers: { 'Retry-After': '1' } }];

      const sent = logMany(10);

      await server.waitFor(() => server.stored.length === 10);
      assert.deepStrictEqual(messages(server), sent);
      assert.strictEqual(server.requests.length, 2);
      assert.ok(server.requests[1].at - server.requests[0].at >= 950, 'waited Retry-After');
    });

    it('keeps the batch on 429 and delivers it after Retry-After', async () => {
      server.replies = [{ status: 429, headers: { 'Retry-After': '1' } }];

      const sent = logMany(10);

      await server.waitFor(() => server.stored.length === 10);
      assert.deepStrictEqual(messages(server), sent);
      assert.ok(server.requests[1].at - server.requests[0].at >= 950, 'waited Retry-After');
    });

    it('does not grow the backoff on Retry-After, and the retry takes a full batch', async () => {
      server.replies = [
        { status: 503, headers: { 'Retry-After': '1' } },
        { status: 503, headers: { 'Retry-After': '1' } },
        { status: 500 },
      ];

      logMany(10);
      await server.waitFor(() => server.requests.length === 1);
      logMany(30, 'later');

      await server.waitFor(() => server.stored.length === 40, 5000);
      assert.deepStrictEqual(server.requests.map(r => r.events.length), [10, 40, 40, 40]);
      const gap = server.requests[3].at - server.requests[2].at;
      assert.ok(gap < 50, `the wait after the 500 is the first backoff, got ${gap}ms`);
    });

    it('waits the backoff on 503 without Retry-After', async () => {
      server.replies = [{ status: 503 }];

      const sent = logMany(10);

      await server.waitFor(() => server.stored.length === 10);
      assert.deepStrictEqual(messages(server), sent);
      assert.ok(server.requests[1].at - server.requests[0].at >= 15);
    });
  });

  describe('when the server or network fails', () => {
    it('retries a 500 with growing backoff and delivers', async () => {
      server.replies = [{ status: 500 }, { status: 502 }];

      const sent = logMany(10);

      await server.waitFor(() => server.stored.length === 10);
      assert.deepStrictEqual(messages(server), sent);
      const [first, second, third] = server.requests.map(r => r.at);
      assert.strictEqual(server.requests.length, 3);
      assert.ok(second - first >= 15, 'first wait is about 20ms');
      assert.ok(third - second >= 30, 'second wait is about 40ms');
    });

    it('delivers normal log events after the server comes back up', async () => {
      const down = await downServer();
      LogNorth.config(down.url, 'test-key', { environment: 'production' });

      const sent = logMany(10, 'info');
      await sleep(100);
      await down.start(down.port);

      try {
        await down.waitFor(() => down.stored.length === 10);
        assert.deepStrictEqual(messages(down), sent);
      } finally {
        await down.stop();
      }
    });

    it('times out a hanging request and retries it', async () => {
      server.replies = [{ status: 201, delayMs: 1000 }];

      const sent = logMany(10);

      await server.waitFor(() => server.stored.length === 10);
      assert.deepStrictEqual(messages(server), sent);
      assert.strictEqual(server.attempts, 2);
    });
  });

  describe('when the server rejects the batch', () => {
    it('splits a 413 batch until the halves fit', async () => {
      server.answer = events => (events.length > 3 ? { status: 413 } : undefined);

      const sent = logMany(10);

      await server.waitFor(() => server.stored.length === 10);
      assert.deepStrictEqual(messages(server), sent);
      assert.ok(server.requests.every(r => r.status === 413 || r.events.length <= 3));
    });

    it('drops and counts a single event that still gets 413', async () => {
      server.answer = events => (events.some(e => e.message === 'too big') ? { status: 413 } : undefined);

      LogNorth.log('ok 1');
      LogNorth.log('too big');
      LogNorth.log('ok 2');
      await LogNorth.flush();

      assert.deepStrictEqual(messages(server), ['ok 1', 'ok 2', 'LogNorth client dropped 1 events']);
      const report = server.stored[2].context;
      assert.strictEqual(report?.dropped, 1);
      assert.strictEqual(report?.dropped_errors, 0);
      assert.strictEqual(report?.environment, 'production');
    });

    it('keeps events on 401 and delivers them once the key works', async () => {
      server.replies = [{ status: 401 }, { status: 401 }];

      const sent = logMany(10);

      await server.waitFor(() => server.stored.length === 10);
      assert.deepStrictEqual(messages(server), sent);
      const [first, second, third] = server.requests.map(r => r.at);
      assert.ok(second - first >= 45, 'first wait is the config backoff');
      assert.ok(third - second >= 95, 'second wait doubles');
    });
  });

  describe('when the queue reaches a limit', () => {
    it('drops the oldest non-error events past 10,000 events and reports the count', async () => {
      const down = await downServer();
      LogNorth.config(down.url, 'test-key', { environment: 'production' });

      for (let i = 0; i < 5; i++) LogNorth.error(`err ${i}`, new Error('boom'));
      const sent = logMany(10_050, 'log');
      await sleep(100); // the first attempt fails, so the in-flight error goes back too
      await down.start(down.port);

      try {
        await down.waitFor(() => messages(down).at(-1)?.startsWith('LogNorth client dropped') ?? false, 5000);
        const got = messages(down);
        assert.deepStrictEqual(got.slice(0, 5), ['err 0', 'err 1', 'err 2', 'err 3', 'err 4']);
        assert.deepStrictEqual(got.slice(5, -1), sent.slice(55));
        const report = down.stored.at(-1)?.context;
        assert.strictEqual(report?.dropped, 55);
        assert.strictEqual(report?.dropped_errors, 0);
      } finally {
        await down.stop();
      }
    });

    it('drops the oldest non-error events past 10 MB', async () => {
      const down = await downServer();
      LogNorth.config(down.url, 'test-key', { environment: 'production' });
      const big: Record<string, string> = {};
      for (let i = 0; i < 7; i++) big[`field_${i}`] = 'x'.repeat(8000);

      LogNorth.error('big err', new Error('boom'), big);
      const sent = logMany(200, 'big', big);
      await sleep(100);
      await down.start(down.port);

      try {
        await down.waitFor(() => messages(down).at(-1)?.startsWith('LogNorth client dropped') ?? false, 5000);
        const got = messages(down);
        const report = down.stored.at(-1)?.context as { dropped: number; dropped_errors: number };
        assert.strictEqual(got[0], 'big err');
        assert.ok(report.dropped > 0);
        assert.strictEqual(report.dropped_errors, 0);
        assert.deepStrictEqual(got.slice(1, -1), sent.slice(report.dropped));
        const delivered = down.requests.filter(r => r.status < 300).reduce((n, r) => n + r.bytes, 0);
        assert.ok(delivered <= 10.1 * 1024 * 1024, 'the queue stayed near 10 MB');
      } finally {
        await down.stop();
      }
    });

    it('drops errors only when the queue holds nothing else', async () => {
      Object.assign(_settings, { maxEvents: 100 });
      const down = await downServer();
      LogNorth.config(down.url, 'test-key', { environment: 'production' });

      try {
        for (let i = 0; i < 105; i++) LogNorth.error(`err ${i}`, new Error('boom'));
        await sleep(100);
        await down.start(down.port);

        await down.waitFor(() => messages(down).at(-1)?.startsWith('LogNorth client dropped') ?? false);
        const report = down.stored.at(-1)?.context;
        assert.strictEqual(report?.dropped, 5);
        assert.strictEqual(report?.dropped_errors, 5);
        assert.strictEqual(messages(down)[0], 'err 5');
      } finally {
        Object.assign(_settings, { maxEvents: defaults.maxEvents });
        await down.stop();
      }
    });
  });

  describe('trimming', () => {
    it('trims a huge event before it enters the queue and delivers it', async () => {
      const err = new Error('boom');
      err.stack = 'Error: boom\n    at top (app.js:1:1)\n' + 's'.repeat(50 * 1024);

      LogNorth.error('m'.repeat(2000), err, { blob: 'b'.repeat(100 * 1024) });

      await server.waitFor(() => server.stored.length === 1);
      const [event] = server.stored;
      const context = event.context as Record<string, string | boolean>;
      assert.strictEqual(event.message.length, 1000);
      assert.strictEqual(context.truncated, true);
      assert.strictEqual((context.blob as string).length, 8 * 1024);
      assert.strictEqual((context.stack_trace as string).length, 16 * 1024);
      assert.ok((context.stack_trace as string).startsWith('Error: boom\n    at top'));
      assert.ok(server.requests[0].bytes <= 64 * 1024);
    });

    it('keeps only the essential context when strings are not enough', async () => {
      const context: Record<string, unknown> = { method: 'GET', path: '/x', status: 500 };
      for (let i = 0; i < 10; i++) context[`field_${i}`] = 'x'.repeat(8 * 1024);

      LogNorth.log('GET /x → 500', context);
      await LogNorth.flush();

      assert.deepStrictEqual(server.stored[0].context, { truncated: true, method: 'GET', path: '/x', status: 500, environment: 'production' });
    });
  });

  describe('batches', () => {
    it('never holds more than 500 events', async () => {
      logMany(1200);

      await server.waitFor(() => server.stored.length === 1200);
      assert.ok(server.requests.every(r => r.events.length <= 500));
      assert.ok(server.requests.some(r => r.events.length === 500));
    });

    it('never holds more than 1 MB of JSON', async () => {
      const big: Record<string, string> = {};
      for (let i = 0; i < 7; i++) big[`field_${i}`] = 'x'.repeat(8000);

      logMany(40, 'big', big);

      await server.waitFor(() => server.stored.length === 40);
      assert.ok(server.requests.every(r => r.bytes <= 1024 * 1024));
      assert.ok(server.requests.some(r => r.bytes > 900 * 1024));
    });
  });

  describe('order and backoff', () => {
    it('delivers events in the order they were logged across retries', async () => {
      server.replies = [{ status: 503 }, { status: 500 }];
      const sent: string[] = [];

      for (let i = 0; i < 30; i++) {
        sent.push(`event ${i}`);
        LogNorth.log(`event ${i}`);
        if (i % 7 === 0) await sleep(10);
      }

      await server.waitFor(() => server.stored.length === 30);
      assert.deepStrictEqual(messages(server), sent);
    });

    it('keeps events logged during a backoff and never sends before the wait is over', async () => {
      server.replies = [{ status: 503, headers: { 'Retry-After': '1' } }];

      const first = logMany(10, 'before');
      await server.waitFor(() => server.requests.length === 1);
      const during = logMany(15, 'during');
      await sleep(500);
      assert.strictEqual(server.requests.length, 1, 'no send during the wait');

      await server.waitFor(() => server.stored.length === 25);
      assert.deepStrictEqual(messages(server), [...first, ...during]);
    });
  });

  describe('shutdown', () => {
    it('sends buffered events on flush, ignoring the backoff', async () => {
      server.replies = [{ status: 503, headers: { 'Retry-After': '300' } }];
      const sent = logMany(10);
      await server.waitFor(() => server.requests.length === 1);

      await LogNorth.flush();

      assert.deepStrictEqual(messages(server), sent);
    });

    it('keeps events that fail during flush', async () => {
      server.replies = [{ status: 500 }];
      LogNorth.log('kept');

      await LogNorth.flush();
      assert.strictEqual(server.stored.length, 0);
      await LogNorth.flush();

      assert.deepStrictEqual(messages(server), ['kept']);
    });

    it('stops a flush at a failing batch, so no later batch overtakes it', async () => {
      _settings.batchEvents = 1;
      server.replies = [{ status: 500 }];
      LogNorth.log('first');
      LogNorth.log('second');

      await LogNorth.flush();
      assert.strictEqual(server.stored.length, 0);
      await LogNorth.flush();

      assert.deepStrictEqual(messages(server), ['first', 'second']);
    });

    for (const how of ['exit', 'SIGTERM'] as const) {
      it(`sends buffered events on ${how}`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'lognorth-'));
        const script = join(dir, 'child.ts');
        writeFileSync(script, `
          import LogNorth from ${JSON.stringify(new URL('./index.ts', import.meta.url).pathname)};
          LogNorth.config(${JSON.stringify(server.url)}, 'test-key', { environment: 'production' });
          LogNorth.log('child 1');
          LogNorth.log('child 2');
          ${how === 'SIGTERM' ? "setInterval(() => {}, 1000); console.log('ready');" : ''}
        `);

        const child = spawn(process.execPath, [...process.execArgv, script], { stdio: ['ignore', 'pipe', 'inherit'] });
        if (how === 'SIGTERM') child.stdout.once('data', () => child.kill('SIGTERM'));
        const code = await new Promise(resolve => child.on('exit', resolve));

        assert.strictEqual(code, 0);
        assert.deepStrictEqual(messages(server), ['child 1', 'child 2']);
      });
    }
  });
});
