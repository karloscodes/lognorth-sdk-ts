import type { LogFunction } from './index.js';

type Context = { req: { method: string; path: string }; res: { status: number } };
type Next = () => Promise<void>;

export function middleware(log: LogFunction) {
  return async (c: Context, next: Next) => {
    const start = Date.now();

    await next();

    try {
      const duration = Date.now() - start;
      const status = c.res.status;

      log(`${c.req.method} ${c.req.path} → ${status}`, {
        method: c.req.method,
        path: c.req.path,
        status,
        duration_ms: duration,
        ...(status >= 500 && { error: `HTTP ${status}` }),
      });
    } catch {
      // Never break the app
    }
  };
}
