import LogNorth from './index.js';

type Handler = (req: Request) => Promise<Response> | Response;

export function withLogger(handler: Handler): Handler {
  return async (req: Request) => {
    const start = Date.now();
    const url = new URL(req.url);

    try {
      const res = await handler(req);
      LogNorth.log(`${req.method} ${url.pathname} → ${res.status}`, {
        method: req.method,
        path: url.pathname,
        status: res.status,
        duration_ms: Date.now() - start,
      });
      return res;
    } catch (err) {
      LogNorth.error(`${req.method} ${url.pathname} → error`, err as Error, {
        method: req.method,
        path: url.pathname,
        duration_ms: Date.now() - start,
      });
      throw err;
    }
  };
}
