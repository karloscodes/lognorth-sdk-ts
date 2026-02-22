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

let apiKey = '';
let endpoint = '';
let buffer: Event[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let backoff = 0;

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
      if (!isError) buffer.unshift(...events);
    }
  } catch {
    if (isError) buffer.unshift(...events);
  }
}

async function flush(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!buffer.length) return;
  const events = buffer;
  buffer = [];
  await send(events);
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
function _log(message: string, context: Context | undefined, trace_id: string, duration_ms?: number): void {
  buffer.push({ message, timestamp: new Date().toISOString(), duration_ms, trace_id, context });
  schedule();
  if (buffer.length >= 10) flush();
}

function _error(message: string, err: Error, context: Context | undefined, trace_id: string, duration_ms?: number): void {
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
    error: err.message,
    error_class: err.name || 'Error',
    error_file: errorFile,
    error_line: errorLine,
    error_caller: errorCaller,
    stack_trace: err.stack,
  };

  send([{ message, timestamp: new Date().toISOString(), duration_ms, trace_id, context: errorContext }], true);
}

const LogNorth = {
  config(url: string, key: string): void {
    endpoint = url;
    apiKey = key;
  },

  log(message: string, context?: Context): void {
    _log(message, context, getTraceID() || '');
  },

  error(message: string, err: Error, context?: Context): void {
    _error(message, err, context, getTraceID() || '');
  },

  flush,
};

export default LogNorth;
export { LogNorth, withTraceID, generateTraceID, _log, _error };
