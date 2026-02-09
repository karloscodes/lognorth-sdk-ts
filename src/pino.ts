import LogNorth from './index.js';
import { Transform } from 'stream';

/**
 * Pino transport that sends logs to LogNorth.
 * Use alongside pino-pretty or other transports for local output.
 */
export function transport(): Transform {
  return new Transform({
    objectMode: true,
    transform(chunk, _encoding, callback) {
      try {
        const log = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
        const { level, msg, time, err, error, ...context } = log;

        // Pino levels: 10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal
        if (level >= 50) {
          const e = err || error || new Error(msg);
          LogNorth.error(msg || 'Error', e instanceof Error ? e : new Error(String(e)), context);
        } else {
          LogNorth.log(msg || '', context);
        }
      } catch {
        // Don't break the stream
      }
      callback(null, chunk);
    },
  });
}
