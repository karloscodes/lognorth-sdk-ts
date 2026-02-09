import LogNorth from './index.js';

type Handler = (req: Request) => Promise<Response> | Response;

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  info(obj: object, msg?: string): void;
  error(msg: string, ...args: unknown[]): void;
  error(obj: object, msg?: string): void;
}

/**
 * Next.js wrapper that logs requests.
 * @param logger Optional logger (pino, winston, etc). Uses LogNorth directly if not provided.
 */
export function withLogger(logger?: Logger) {
  return (handler: Handler): Handler => {
    return async (req: Request) => {
      const start = Date.now();
      const url = new URL(req.url);

      try {
        const res = await handler(req);
        const data = {
          method: req.method,
          path: url.pathname,
          status: res.status,
          duration_ms: Date.now() - start,
        };
        const msg = `${req.method} ${url.pathname} → ${res.status}`;

        if (logger) {
          logger.info(data, msg);
        } else {
          LogNorth.log(msg, data);
        }
        return res;
      } catch (err) {
        const data = {
          method: req.method,
          path: url.pathname,
          duration_ms: Date.now() - start,
        };
        const msg = `${req.method} ${url.pathname} → error`;

        if (logger) {
          logger.error({ ...data, err }, msg);
        } else {
          LogNorth.error(msg, err as Error, data);
        }
        throw err;
      }
    };
  };
}
