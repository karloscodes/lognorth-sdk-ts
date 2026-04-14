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

const MAX_BUFFER = 1000;

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

let apiKey = '';
let endpoint = '';
let environment = '';
let enabled = true;
let buffer: Event[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let backoff = 0;
let flushing = false;

function stampEnvironment(context: Context | undefined): Context | undefined {
  if (!environment) return context;
  return { ...(context ?? {}), environment };
}

async function send(events: Event[], isError = false): Promise<void> {
  if (!events.length || !endpoint) return;
  if (Date.now() < backoff) return;

  try {
    const res = await fetch(`${endpoint}/api/v1/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ events }),
    });

    if (res.status === 429) {
      backoff = Date.now() + 5000;
      requeue(events);
    }
  } catch {
    if (isError) requeue(events);
  }
}

function requeue(events: Event[]): void {
  buffer = [...events, ...buffer].slice(0, MAX_BUFFER);
}

async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!buffer.length) return;
    const events = buffer;
    buffer = [];
    await send(events);
  } finally {
    flushing = false;
  }
}

function schedule(): void {
  if (!timer) timer = setTimeout(flush, 5000);
}

if (typeof process !== 'undefined') {
  process.on('beforeExit', flush);
  process.on('SIGINT', () => flush().then(() => process.exit(0)));
  process.on('SIGTERM', () => flush().then(() => process.exit(0)));
}

// Internal: used by middleware to set duration_ms and trace_id on events
function _log(message: string, context: Context | undefined, trace_id: string, duration_ms?: number, timestamp?: Date): void {
  if (!enabled) return;
  const event: Event = { message, timestamp: (timestamp ?? new Date()).toISOString(), context: stampEnvironment(context) };
  if (trace_id) event.trace_id = trace_id;
  if (duration_ms !== undefined) event.duration_ms = duration_ms;
  buffer.push(event);
  if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
  schedule();
  if (buffer.length >= 10) flush();
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
  send([event], true);
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
export { LogNorth, withTraceID, generateTraceID, getTraceID, _log, _error };
