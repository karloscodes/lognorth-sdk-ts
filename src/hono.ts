import LogNorth from './index.js';

type Context = { req: { method: string; path: string }; res: { status: number } };
type Next = () => Promise<void>;

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  info(obj: object, msg?: string): void;
}

/**
 * Hono middleware that logs requests.
 * @param logger Optional logger (pino, winston, etc). Uses LogNorth directly if not provided.
 */
export function middleware(logger?: Logger) {
  return async (c: Context, next: Next) => {
    const start = Date.now();
    await next();

    const data = {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Date.now() - start,
    };
    const msg = `${c.req.method} ${c.req.path} → ${c.res.status}`;

    if (logger) {
      logger.info(data, msg);
    } else {
      LogNorth.log(msg, data);
    }
  };
}
