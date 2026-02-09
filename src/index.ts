type Context = Record<string, unknown>;
type Event = { message: string; timestamp: string; error_type?: string; context?: Context };

let apiKey = process.env.LOGNORTH_API_KEY || '';
let endpoint = process.env.LOGNORTH_URL || '';
let buffer: Event[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let backoff = 0;

async function send(events: Event[], isError = false): Promise<void> {
  if (!events.length || !endpoint) return;

  // Respect backoff
  if (Date.now() < backoff) return;

  try {
    const res = await fetch(`${endpoint}/api/v1/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ events }),
    });

    if (res.status === 429) {
      backoff = Date.now() + 5000;
      // Re-queue events if server is busy
      if (!isError) buffer.unshift(...events);
    }
  } catch {
    // Network error - re-queue errors only
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

// Auto-flush on shutdown
if (typeof process !== 'undefined') {
  process.on('beforeExit', flush);
  process.on('SIGINT', () => flush().then(() => process.exit(0)));
  process.on('SIGTERM', () => flush().then(() => process.exit(0)));
}

/**
 * Configure LogNorth. Optional - reads from env vars by default.
 */
export function config(opts: { apiKey?: string; endpoint?: string }): void {
  if (opts.apiKey) apiKey = opts.apiKey;
  if (opts.endpoint) endpoint = opts.endpoint;
}

/**
 * Log a message. Batched and sent every 5s or 10 events.
 */
export function log(message: string, context?: Context): void {
  buffer.push({ message, timestamp: new Date().toISOString(), context });
  schedule();
  if (buffer.length >= 10) flush();
}

/**
 * Log an error. Sent immediately.
 */
export function error(message: string, opts: { error: Error } & Context): void {
  const { error: err, ...context } = opts;
  const event: Event = {
    message,
    timestamp: new Date().toISOString(),
    error_type: err.name || 'Error',
    context: { ...context, error: err.message, stack: err.stack },
  };
  send([event], true);
}

log.error = error;
log.flush = flush;
log.config = config;

export { flush };
export default log;
