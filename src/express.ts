import type { Request, Response, NextFunction, RequestHandler } from 'express';
import LogNorth from './index.js';

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  info(obj: object, msg?: string): void;
  error(msg: string, ...args: unknown[]): void;
  error(obj: object, msg?: string): void;
}

/**
 * Express middleware that logs requests.
 * @param logger Optional logger (pino, winston, etc). Uses LogNorth directly if not provided.
 */
export function middleware(logger?: Logger): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();

    res.on('finish', () => {
      const data = {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - start,
      };
      const msg = `${req.method} ${req.path} → ${res.statusCode}`;

      if (logger) {
        logger.info(data, msg);
      } else {
        LogNorth.log(msg, data);
      }
    });

    next();
  };
}
