import { AsyncLocalStorage } from 'node:async_hooks';

type Context = Record<string, unknown>;

type ErrorContext = Context & {
  error: string;
  error_class: string;
  error_file: string;
  error_line: number;
  error_caller: string;
  stack_trace?: string;
};

type Event = {
  message: string;
  timestamp: string;
  duration_ms?: number;
  trace_id?: string;
  context?: Context | ErrorContext;
};

function generateTraceID(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

const traceStore = new AsyncLocalStorage<string>();

function withTraceID<T>(traceID: string, fn: () => T): T {
  return traceStore.run(traceID, fn);
}

function getTraceID(): string | undefined {
  return traceStore.getStore();
}

// Internal settings. Tests shorten the waits; apps never change them.
const _settings = {
  maxEvents: 10_000,
  maxBytes: 10 * 1024 * 1024,
  maxEventBytes: 64 * 1024,
  maxMessageChars: 1000,
  maxStackBytes: 16 * 1024,
  maxStringBytes: 8 * 1024,
  batchEvents: 500,
  batchBytes: 1024 * 1024,
  wakeCount: 10,
  wakeMs: 5000,
  backoffMs: 1000,
  backoffMaxMs: 60_000,
  configBackoffMs: 60_000,
  configBackoffMaxMs: 300_000,
  requestTimeoutMs: 10_000,
  shutdownMs: 5000,
};

// Context keys kept when an event is still too big after trimming its strings.
const ESSENTIAL_KEYS = ['error', 'error_class', 'error_file', 'error_line', 'method', 'path', 'status', 'environment'];

// A queued event, with the byte length of its JSON measured once.
type Entry = { event: Event; size: number; isError: boolean };

type Outcome = 'sent' | 'retry' | 'split' | 'drop';

let apiKey = '';
let endpoint = '';
let environment = '';
let enabled = true;
let queue: Entry[] = [];
let queueBytes = 0;
let splits: number[] = []; // batch sizes for the front of the queue after a 413
let dropped = 0;
let droppedErrors = 0;
let backoff = _settings.backoffMs;
let configBackoff = _settings.configBackoffMs;
let nextSendAt = 0;
let urgent = false;
let failing = false;
let misconfigured = false;
let sending: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let timerAt = 0;

const encoder = new TextEncoder();

function byteLength(s: string): number {
  return encoder.encode(s).length;
}

function warn(message: string): void {
  console.error(`[lognorth] ${message}`);
}

function stampEnvironment(context: Context | undefined): Context | undefined {
  if (!environment) return context;
  return { ...(context ?? {}), environment };
}

function truncateBytes(s: string, max: number): string {
  let out = s.length > max ? s.slice(0, max) : s;
  let bytes = byteLength(out);
  while (bytes > max) {
    out = out.slice(0, Math.floor(out.length * max / bytes));
    bytes = byteLength(out);
  }
  return out;
}

function isErrorEvent(context: Context | undefined): boolean {
  if (!context) return false;
  return Boolean(context.error || context.error_class) || (typeof context.status === 'number' && context.status >= 500);
}

// Trim an event so one huge event cannot eat the queue budget.
function toEntry(event: Event): Entry {
  let truncated = false;
  if (typeof event.message === 'string' && event.message.length > _settings.maxMessageChars) {
    event.message = event.message.slice(0, _settings.maxMessageChars);
    truncated = true;
  }

  if (event.context) {
    const context: Context = { ...event.context };
    for (const [key, value] of Object.entries(context)) {
      if (typeof value !== 'string') continue;
      const cut = truncateBytes(value, key === 'stack_trace' ? _settings.maxStackBytes : _settings.maxStringBytes);
      if (cut !== value) { context[key] = cut; truncated = true; }
    }
    if (truncated) context.truncated = true;
    event.context = context;
  } else if (truncated) {
    event.context = { truncated: true };
  }

  let size = byteLength(JSON.stringify(event));
  if (size > _settings.maxEventBytes) {
    const context: Context = { truncated: true };
    for (const key of ESSENTIAL_KEYS) {
      if (event.context && key in event.context) context[key] = event.context[key];
    }
    event.context = context;
    size = byteLength(JSON.stringify(event));
  }

  return { event, size, isError: isErrorEvent(event.context) };
}

function countDrop(isError: boolean): void {
  if (!dropped) warn('dropping events; a report follows once delivery works');
  dropped++;
  if (isError) droppedErrors++;
}

// Drop the oldest non-error event first; errors go last.
function enforceLimits(): void {
  while (queue.length > _settings.maxEvents || queueBytes > _settings.maxBytes) {
    let i = queue.findIndex(e => !e.isError);
    if (i < 0) i = 0;
    const [gone] = queue.splice(i, 1);
    queueBytes -= gone.size;
    splits = [];
    countDrop(gone.isError);
  }
}

function due(): boolean {
  return urgent
    || queue.length >= _settings.wakeCount
    || queue.length > _settings.maxEvents / 2
    || queueBytes > _settings.maxBytes / 2;
}

function enqueue(event: Event): void {
  let entry: Entry;
  try {
    entry = toEntry(event);
  } catch {
    // Context that cannot become JSON (circular, BigInt) can never be delivered.
    countDrop(isErrorEvent(event.context));
    return;
  }
  const wasEmpty = !queue.length;
  queue.push(entry);
  queueBytes += entry.size;
  enforceLimits();
  if (entry.isError) urgent = true;
  if (due()) kick(true);
  else if (wasEmpty) kick();
}

// Take up to batchEvents events and batchBytes of JSON from the front.
function take(): Entry[] {
  const limit = Math.min(splits.shift() ?? Infinity, _settings.batchEvents);
  let n = 0;
  let bytes = '{"events":[]}'.length;
  while (n < queue.length && n < limit) {
    const next = bytes + queue[n].size + (n > 0 ? 1 : 0);
    if (n > 0 && next > _settings.batchBytes) break;
    bytes = next;
    n++;
  }
  const batch = queue.splice(0, n);
  for (const e of batch) queueBytes -= e.size;
  return batch;
}

function putBack(batch: Entry[]): void {
  queue = batch.concat(queue);
  for (const e of batch) queueBytes += e.size;
  enforceLimits();
}

function wait(ms: number): void {
  nextSendAt = Date.now() + ms;
}

function markFailing(reason: string): void {
  if (!failing) warn(`delivery failed (${reason}); events stay queued and retry`);
  failing = true;
}

function succeeded(): void {
  if (failing || misconfigured) warn('delivery recovered');
  failing = false;
  misconfigured = false;
  backoff = _settings.backoffMs;
  configBackoff = _settings.configBackoffMs;
  nextSendAt = 0;
  if (dropped) {
    const message = `LogNorth client dropped ${dropped} events`;
    const context = stampEnvironment({ dropped, dropped_errors: droppedErrors });
    dropped = 0;
    droppedErrors = 0;
    enqueue({ message, timestamp: new Date().toISOString(), context });
  }
}

function outcome(status: number, retryAfter: string | null, size: number): Outcome {
  if (status >= 200 && status < 300) {
    succeeded();
    return 'sent';
  }

  if (status === 401 || status === 403 || status === 404) {
    if (!misconfigured) warn(`server answered ${status}; check the endpoint and API key. Events stay queued.`);
    misconfigured = true;
    wait(configBackoff);
    configBackoff = Math.min(configBackoff * 2, _settings.configBackoffMaxMs);
    return 'retry';
  }

  if (status === 429 || status === 503) {
    markFailing(`status ${status}`);
    const seconds = retryAfter && /^\d+$/.test(retryAfter.trim()) ? parseInt(retryAfter, 10) : null;
    if (seconds !== null) {
      // The server said when; the backoff stays for failures that do not say.
      wait(Math.min(Math.max(seconds, 1), 300) * 1000);
    } else {
      wait(backoff);
      backoff = Math.min(backoff * 2, _settings.backoffMaxMs);
    }
    return 'retry';
  }

  if (status === 0 || status === 408 || status >= 500) {
    markFailing(status ? `status ${status}` : 'network error or timeout');
    wait(backoff * (0.8 + Math.random() * 0.4));
    backoff = Math.min(backoff * 2, _settings.backoffMaxMs);
    return 'retry';
  }

  // 400, 413, and other 4xx: the server cannot take this batch as it is.
  return size > 1 ? 'split' : 'drop';
}

async function post(batch: Entry[], timeoutMs: number): Promise<Outcome> {
  let status = 0;
  let retryAfter: string | null = null;
  try {
    const res = await fetch(`${endpoint}/api/v1/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ events: batch.map(e => e.event) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    retryAfter = res.headers.get('retry-after');
    await res.arrayBuffer().catch(() => {});
  } catch {
    status = 0;
  }
  return outcome(status, retryAfter, batch.length);
}

function settle(batch: Entry[], result: Outcome): void {
  if (result === 'retry') {
    // The next send takes a full batch again; a refused batch splits again.
    splits = [];
    putBack(batch);
  } else if (result === 'split') {
    putBack(batch);
    splits.unshift(Math.ceil(batch.length / 2), Math.floor(batch.length / 2));
  } else if (result === 'drop') {
    countDrop(batch[0].isError);
  }
}

function canSend(): boolean {
  return enabled && Boolean(endpoint) && queue.length > 0;
}

async function pump(): Promise<void> {
  while (canSend() && Date.now() >= nextSendAt) {
    const batch = take();
    settle(batch, await post(batch, _settings.requestTimeoutMs));
  }
}

function clearTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

// Wake the sender at `at`, unless an earlier wake is already set.
function arm(at: number): void {
  if (timer && timerAt <= at) return;
  clearTimer();
  timerAt = at;
  timer = setTimeout(() => { timer = null; kick(true); }, Math.max(0, at - Date.now()));
  // Do not keep the process alive for a wait; beforeExit sends what is left.
  (timer as { unref?: () => void }).unref?.();
}

// Start the sender when events are due. Only one send is in flight at a time.
function kick(now = false): void {
  if (sending || !canSend()) return;
  if (Date.now() < nextSendAt) return arm(nextSendAt);
  if (!now && !due()) return arm(Date.now() + _settings.wakeMs);
  clearTimer();
  urgent = false;
  sending = pump().finally(() => { sending = null; kick(urgent); });
}

// Resolves true when `promise` settles before `deadline`, false otherwise.
async function settlesBefore(promise: Promise<void>, deadline: number): Promise<boolean> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>(resolve => { t = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())); });
  try {
    return await Promise.race([promise.then(() => true), late]);
  } finally {
    clearTimeout(t);
  }
}

// Send what is queued now: one attempt per batch, ignoring any backoff,
// within the shutdown deadline. Batches that fail stay queued.
async function flush(): Promise<void> {
  const deadline = Date.now() + _settings.shutdownMs;
  while (sending) {
    if (!(await settlesBefore(sending, deadline))) return;
  }
  if (!canSend()) return;
  clearTimer();
  sending = (async () => {
    while (canSend() && Date.now() < deadline) {
      const batch = take();
      const result = await post(batch, Math.max(1, Math.min(_settings.requestTimeoutMs, deadline - Date.now())));
      // A failed batch goes back to the front and the flush stops: a later
      // batch must not overtake it, or events arrive out of order.
      if (result === 'retry') { putBack(batch); break; }
      settle(batch, result);
    }
  })().finally(() => { sending = null; kick(); });
  await settlesBefore(sending, deadline);
}

async function shutdown(): Promise<void> {
  await flush();
  clearTimer();
  if (!queue.length) return;
  warn(`dropped ${queue.length} events at shutdown`);
  queue = [];
  queueBytes = 0;
  splits = [];
}

if (typeof process !== 'undefined') {
  process.on('beforeExit', () => { shutdown(); });
  process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));
  process.on('exit', () => { if (queue.length) warn(`dropped ${queue.length} events at exit`); });
}

// Internal: tests call this to start each case from a clean state.
function _reset(): void {
  clearTimer();
  queue = [];
  queueBytes = 0;
  splits = [];
  dropped = 0;
  droppedErrors = 0;
  backoff = _settings.backoffMs;
  configBackoff = _settings.configBackoffMs;
  nextSendAt = 0;
  urgent = false;
  failing = false;
  misconfigured = false;
}

// Internal: used by middleware to set duration_ms and trace_id on events
function _log(message: string, context: Context | undefined, trace_id: string, duration_ms?: number, timestamp?: Date): void {
  if (!enabled) return;
  const event: Event = { message, timestamp: (timestamp ?? new Date()).toISOString(), context: stampEnvironment(context) };
  if (trace_id) event.trace_id = trace_id;
  if (duration_ms !== undefined) event.duration_ms = duration_ms;
  enqueue(event);
}

function _error(message: string, err: Error, context: Context | undefined, trace_id: string, duration_ms?: number, timestamp?: Date): void {
  if (!enabled) return;
  let errorFile = '';
  let errorLine = 0;
  let errorCaller = '';
  if (err.stack) {
    const match = err.stack.match(/\n\s+at\s+(?:(.+?)\s+\()?(.+?):(\d+):\d+\)?/);
    if (match) {
      errorCaller = match[1] || '';
      errorFile = match[2] || '';
      errorLine = parseInt(match[3], 10) || 0;
    }
  }

  const errorContext: ErrorContext = {
    ...context,
    ...(environment ? { environment } : {}),
    error: err.message,
    error_class: err.name || 'Error',
    error_file: errorFile,
    error_line: errorLine,
    error_caller: errorCaller,
    stack_trace: err.stack,
  };

  const event: Event = { message, timestamp: (timestamp ?? new Date()).toISOString(), context: errorContext };
  if (trace_id) event.trace_id = trace_id;
  if (duration_ms !== undefined) event.duration_ms = duration_ms;
  enqueue(event);
}

interface ConfigOptions {
  /** Environment label stamped on every event (e.g. "production", "staging"). Defaults to NODE_ENV. */
  environment?: string;
  /** Override the auto-disable in test/development. */
  enabled?: boolean;
}

const LogNorth = {
  config(url: string, key: string, options: ConfigOptions = {}): void {
    endpoint = url;
    apiKey = key;
    const nodeEnv = typeof process !== 'undefined' ? (process.env?.NODE_ENV ?? '') : '';
    environment = options.environment ?? nodeEnv;
    // Default off only in development/test. Staging, preview, qa, production
    // all opt in automatically. Explicit `enabled` always wins.
    enabled = options.enabled ?? !['development', 'test'].includes(environment);
    kick();
  },

  log(message: string, context?: Context): void {
    _log(message, context, getTraceID() ?? '');
  },

  error(message: string, err: Error, context?: Context): void {
    _error(message, err, context, getTraceID() ?? '');
  },

  flush,
};

export default LogNorth;
export { LogNorth, withTraceID, generateTraceID, getTraceID, _log, _error, _settings, _reset };
