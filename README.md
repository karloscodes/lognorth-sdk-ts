# lognorth

[![CI](https://github.com/karloscodes/lognorth-sdk-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/karloscodes/lognorth-sdk-ts/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/lognorth)](https://www.npmjs.com/package/lognorth)
[![License](https://img.shields.io/github/license/karloscodes/lognorth-sdk-ts)](LICENSE)

Official JavaScript SDK for [LogNorth](https://lognorth.com), self-hosted error tracking and logging. It sends logs and errors from your Node.js app to your LogNorth server.

It has middleware for Express, Hono, and Next.js, and a transport for Pino. See the [LogNorth docs](https://lognorth.com/docs/).

## Install

```bash
npm install lognorth
```

## Use

```typescript
import LogNorth from 'lognorth'

LogNorth.config('https://logs.yoursite.com', 'your-api-key')

LogNorth.log('User signed up', { user_id: 123 })
LogNorth.error('Checkout failed', err, { order_id: 42 })
```

`LogNorth.log` and `LogNorth.error` return at once. They never throw into your app.

## With Pino

Keep your Pino setup and add LogNorth as a transport:

```typescript
import pino from 'pino'
import { transport } from 'lognorth/pino'

LogNorth.config('https://logs.yoursite.com', 'your-api-key')

const logger = pino({ level: 'info' }, transport())

logger.info({ user_id: 123 }, 'User signed up')  // sent to LogNorth
logger.error({ err }, 'Checkout failed')          // sent to LogNorth at once
```

Pass your logger to the Express middleware. It sends request events to that logger, and your Pino transport then sends them to LogNorth:

```typescript
import { middleware } from 'lognorth/express'
app.use(middleware(logger))
```

## Middleware

```typescript
// Express
import { middleware } from 'lognorth/express'
app.use(middleware())

// Hono
import { middleware } from 'lognorth/hono'
app.use(middleware())

// Next.js
import { withLogger } from 'lognorth/next'
export const GET = withLogger()(handler)
```

Each request logs one event with `method`, `path`, `status`, and `duration_ms`. Express also adds `route` and `handler` when it matches a route. Express skips a 404 that matches no route.

Each response carries an `X-Trace-ID` header. An incoming `x-trace-id` header keeps its value. Every log and error in the request carries the trace ID.

### Who hit the error, and in which release

Name the signed-in user inside a request. Use an ID, not an email:

```typescript
LogNorth.setUser(user.id)
```

The request event carries the user, and so does every log and error in that request. A failed request (5xx) also carries its `user_agent`.

### Skipping noisy endpoints

Health checks and uptime probes fill the log feed if you let them through. Pass `ignorePaths` to skip them:

```typescript
app.use(middleware({ ignorePaths: ['/healthz', '/ping', '/up'] }))
```

There is no default list. Matches exact path or `path/…` prefix.

## How it works

- `LogNorth.log()` queues the event. The SDK sends when 10 events wait, or 5 seconds after the first one.
- `LogNorth.error()` queues the event and sends at once.
- The SDK sends one request at a time. A batch holds at most 500 events and 1 MB.
- A failed send keeps its events. The SDK retries them first, so events arrive in order.
- On 429 or 503, the SDK waits for the `Retry-After` seconds, from 1 to 300. Without that header, it uses the doubling wait below.
- On other server or network errors, the SDK waits 1 second, then doubles the wait, up to 60 seconds.
- On 401, 403, or 404, the SDK writes one line to stderr and keeps the events. It retries after 60 seconds, then up to every 5 minutes.
- If the server rejects a batch as too large or invalid, the SDK splits it. It drops a single event that the server still rejects.
- Each request times out after 10 seconds.
- Each event is trimmed to 64 KB. The SDK marks it with `context.truncated = true`.
- The queue holds up to 10,000 events or 10 MB. When it is full, the SDK drops the oldest non-error event. Errors go last.
- After drops, the next successful send adds a `LogNorth client dropped N events` event with the counts.
- `LogNorth.flush()` sends queued batches once each, within 5 seconds. It stops at the first failed batch. Events that fail stay queued.
- On exit, SIGINT, and SIGTERM, the SDK flushes. It drops what is still queued and writes the count to stderr.

## Configuration

```typescript
LogNorth.config(url, key, {
  environment: 'production',           // stamped on every event; defaults to NODE_ENV
  enabled: true,                       // defaults to off when environment is development or test
  release: process.env.APP_VERSION,    // errors carry it
})
```

The SDK sends off in `development` and `test` by default. Any other environment sends. `enabled` overrides the default.

When no `release` is set, the SDK reads the first of these variables that has a value: `LOGNORTH_RELEASE`, `GIT_SHA`, `GIT_COMMIT`, `SOURCE_COMMIT`, `KAMAL_VERSION`, `RENDER_GIT_COMMIT`, `HEROKU_SLUG_COMMIT`, `SOURCE_VERSION`, `RAILWAY_GIT_COMMIT_SHA`, `VERCEL_GIT_COMMIT_SHA`.

When a release is set, the SDK logs `Release <version> started` once at startup.

## Development

```bash
npm ci
npm run build
npm test
```

## License

MIT. See [LICENSE](LICENSE).
