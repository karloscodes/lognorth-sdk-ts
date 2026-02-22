type Context = Record<string, unknown>;

type ErrorContext = Context & {
  error: string;
  error_class: string;
  error_file: string;
  error_line: number;
  error_caller: string;
  stack_trace?: string;
};

type Event = { message: string; timestamp: string; context?: Context | ErrorContext };

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

const LogNorth = {
  config(url: string, key: string): void {
    endpoint = url;
    apiKey = key;
  },

  log(message: string, context?: Context): void {
    buffer.push({ message, timestamp: new Date().toISOString(), context });
    schedule();
    if (buffer.length >= 10) flush();
  },

  error(message: string, err: Error, context?: Context): void {
    // Parse first stack frame: "at funcName (file:line:col)" or "at file:line:col"
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

    const event: Event = {
      message,
      timestamp: new Date().toISOString(),
      context: errorContext,
    };
    send([event], true);
  },

  flush,
};

export default LogNorth;
export { LogNorth };
