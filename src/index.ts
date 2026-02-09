type Context = Record<string, unknown>;
type Event = { message: string; timestamp: string; error_type?: string; context?: Context };

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
    const event: Event = {
      message,
      timestamp: new Date().toISOString(),
      error_type: err.name || 'Error',
      context: { ...context, error: err.message, stack: err.stack },
    };
    send([event], true);
  },

  flush,
};

export default LogNorth;
export { LogNorth };
