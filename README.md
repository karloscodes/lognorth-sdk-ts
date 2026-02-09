# lognorth

Official JavaScript/TypeScript SDK for [LogNorth](https://lognorth.com) - self-hosted error tracking and logging.

## Install

```bash
npm install @karloscodes/lognorth-sdk
```

## Quick Start

```bash
export LOGNORTH_API_KEY=your_api_key
export LOGNORTH_URL=https://logs.yoursite.com
```

```typescript
import { log } from '@karloscodes/lognorth-sdk'

// Log events
log('User signed up', { user_id: 123 })

// Log errors with stack traces
try {
  await checkout(order)
} catch (err) {
  log.error('Checkout failed', { error: err, order_id: order.id })
}
```

That's it. Logs are batched, errors are sent immediately, and everything flushes automatically on shutdown.

## Framework Middleware

### Express

```typescript
import { log } from '@karloscodes/lognorth-sdk'
import { middleware } from '@karloscodes/lognorth-sdk/express'

app.use(middleware(log))
```

### Hono

```typescript
import { log } from '@karloscodes/lognorth-sdk'
import { middleware } from '@karloscodes/lognorth-sdk/hono'

app.use(middleware(log))
```

### Next.js

```typescript
import { log } from '@karloscodes/lognorth-sdk'
import { withLogger } from '@karloscodes/lognorth-sdk/next'

export const GET = withLogger(log)(async (req) => {
  return Response.json({ ok: true })
})
```

## How It Works

- **Regular logs** are batched (10 events or 5 seconds) and sent with 1 retry
- **Errors** are sent immediately with 3 retries and exponential backoff
- **Buffer limit** of 1000 events - drops oldest regular logs first, never drops errors
- **429/503 handling** - automatically backs off when server is busy
- **Auto-flush** on shutdown (SIGINT, SIGTERM, beforeExit)

## Custom Configuration

```typescript
import { createLogger } from '@karloscodes/lognorth-sdk'

const log = createLogger({
  apiKey: 'custom_key',        // Default: LOGNORTH_API_KEY env
  endpoint: 'https://...',     // Default: LOGNORTH_URL env
  batchSize: 10,               // Events before auto-flush
  flushInterval: 5000,         // Ms before auto-flush
  maxBufferSize: 1000,         // Max buffered events
})
```

## License

MIT
