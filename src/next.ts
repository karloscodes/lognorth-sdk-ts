import type { LogFunction } from './index.js';

type NextRequest = Request;
type NextResponse = Response;
type Handler = (req: NextRequest) => Promise<NextResponse> | NextResponse;

export function withLogger(log: LogFunction) {
  return (handler: Handler): Handler => {
    return async (req: NextRequest) => {
      const start = Date.now();

      try {
        const res = await handler(req);

        const duration = Date.now() - start;
        const status = res.status;
        const url = new URL(req.url);

        log(`${req.method} ${url.pathname} → ${status}`, {
          method: req.method,
          path: url.pathname,
          status,
          duration_ms: duration,
          ...(status >= 500 && { error: `HTTP ${status}` }),
        });

        return res;
      } catch (err) {
        const duration = Date.now() - start;
        const url = new URL(req.url);

        log.error(`${req.method} ${url.pathname} → error`, {
          error: err as Error,
          method: req.method,
          path: url.pathname,
          duration_ms: duration,
        });

        throw err;
      }
    };
  };
}
