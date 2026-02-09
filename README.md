# lognorth

Official SDK for [LogNorth](https://lognorth.com) - self-hosted error tracking.

## Install

```bash
npm install @karloscodes/lognorth-sdk
```

## Use

```bash
export LOGNORTH_API_KEY=your_key
export LOGNORTH_URL=https://logs.yoursite.com
```

```typescript
import log from '@karloscodes/lognorth-sdk'

log('User signed up', { user_id: 123 })

log.error('Checkout failed', { error: err, order_id: 42 })
```

That's it. Batches automatically, errors sent immediately, flushes on shutdown.

## Middleware

```typescript
// Express
import { middleware } from '@karloscodes/lognorth-sdk/express'
app.use(middleware())

// Hono
import { middleware } from '@karloscodes/lognorth-sdk/hono'
app.use(middleware())

// Next.js
import { withLogger } from '@karloscodes/lognorth-sdk/next'
export const GET = withLogger(handler)
```

## Config (optional)

```typescript
import { config } from '@karloscodes/lognorth-sdk'
config({ apiKey: '...', endpoint: '...' })
```

## License

MIT
