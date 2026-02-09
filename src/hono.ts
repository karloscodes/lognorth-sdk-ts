import log from './index.js';

type Context = { req: { method: string; path: string }; res: { status: number } };
type Next = () => Promise<void>;

export function middleware() {
  return async (c: Context, next: Next) => {
    const start = Date.now();
    await next();

    const status = c.res.status;
    log(`${c.req.method} ${c.req.path} → ${status}`, {
      method: c.req.method,
      path: c.req.path,
      status,
      duration_ms: Date.now() - start,
    });
  };
}
