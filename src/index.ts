export interface LogNorthConfig {
  apiKey: string;
  endpoint?: string;
  batchSize?: number;
  flushInterval?: number;
  maxBufferSize?: number;
}

export interface LogContext {
  [key: string]: unknown;
}

export type LogFunction = {
  (message: string, context?: LogContext): void;
  error: (message: string, options: { error: Error } & LogContext) => void;
  flush: () => Promise<void>;
};

function parseErrorStack(err: Error): { errorType: string; errorLocation: string } {
  const errorType = err.name || 'Error';
  let errorLocation = '';

  if (err.stack) {
    const match = err.stack.match(/at\s+(?:.*?\s+)?\(?(.+?):(\d+):\d+\)?/);
    if (match) {
      const file = match[1].split('/').pop() || match[1];
      errorLocation = `${file}:${match[2]}`;
    }
  }

  return { errorType, errorLocation };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createLogger(config: LogNorthConfig): LogFunction {
  const endpoint = config.endpoint || 'https://your-lognorth-instance.com';
  const batchSize = config.batchSize ?? 10;
  const baseFlushInterval = config.flushInterval ?? 5000;
  const maxBufferSize = config.maxBufferSize ?? 1000;

  type Event = { message: string; timestamp: string; error_type?: string; error_location?: string; context?: LogContext };
  let buffer: Event[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushInterval = baseFlushInterval;
  let backoffUntil = 0;

  async function send(events: Event[], retries: number = 1): Promise<boolean> {
    if (events.length === 0) return true;

    // Respect backoff from previous 429
    const now = Date.now();
    if (now < backoffUntil) {
      await sleep(backoffUntil - now);
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(`${endpoint}/api/v1/events/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
          body: JSON.stringify({ events }),
        });

        if (res.ok) {
          // Success - gradually recover flush interval
          flushInterval = Math.max(baseFlushInterval, flushInterval * 0.9);
          return true;
        }

        if (res.status === 429) {
          // Server overwhelmed - back off significantly
          flushInterval = Math.min(flushInterval * 2, 60000); // Max 1 minute
          backoffUntil = Date.now() + flushInterval;
        }
      } catch {
        // Network error, will retry
      }

      if (attempt < retries) await sleep(1000 * Math.pow(2, attempt));
    }

    return false;
  }

  function enqueue(event: Event, isError: boolean = false): void {
    // Buffer full - drop oldest non-error events
    if (buffer.length >= maxBufferSize) {
      const nonErrorIndex = buffer.findIndex(e => !e.error_type);
      if (nonErrorIndex >= 0) {
        buffer.splice(nonErrorIndex, 1);
      } else if (!isError) {
        // Buffer full of errors, drop this non-error event
        return;
      }
    }

    buffer.push(event);

    if (!timer) {
      timer = setTimeout(() => { timer = null; flush(); }, flushInterval);
    }

    if (buffer.length >= batchSize) flush();
  }

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    if (timer) { clearTimeout(timer); timer = null; }
    const events = buffer;
    buffer = [];
    await send(events, 1);
  }

  const log = (message: string, context?: LogContext) => {
    enqueue({ message, timestamp: new Date().toISOString(), context }, false);
  };

  log.error = (message: string, options: { error: Error } & LogContext) => {
    const { error, ...context } = options;
    const { errorType, errorLocation } = parseErrorStack(error);

    const event: Event = {
      message,
      timestamp: new Date().toISOString(),
      error_type: errorType,
      error_location: errorLocation,
      context: { ...context, error: error.message, error_stack: error.stack },
    };

    // Errors sent immediately with more retries
    send([event], 3);
  };

  log.flush = flush;
  return log;
}

export default createLogger;
