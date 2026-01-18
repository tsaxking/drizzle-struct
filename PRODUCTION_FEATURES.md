# Production Features

This repository includes 5 production-ready features to enhance drizzle-struct performance, scalability, and observability.

## Features

1. **Database Index Support** (`src/indexing.ts`)
   - Define indexes in struct configuration
   - Automatic index creation during build
   - Support for unique, composite, partial, and full-text search indexes

2. **Redis Connection Pooling** (`src/redis-pool.ts`)
   - Efficient connection pool management
   - Health checks and automatic reconnection
   - Connection statistics and monitoring

3. **Query Result Caching** (`src/caching.ts`)
   - Two-tier caching (in-memory + Redis)
   - Automatic cache invalidation on mutations
   - Multi-instance support via pub/sub

4. **Message Queue Integration** (`src/message-queue.ts`)
   - RabbitMQ/AMQP support for cross-service communication
   - Automatic event publishing for struct operations
   - Dead letter queue support

5. **Telemetry & Metrics** (`src/telemetry.ts`)
   - Performance tracking and metrics collection
   - Distributed tracing with spans
   - Integration-ready for Prometheus and Jaeger

## Quick Start

See `examples/production-setup.ts` for a complete working example using all features together.

### Database Indexes

```typescript
const userStruct = new Struct({
  name: 'users',
  structure: {
    email: text('email').notNull(),
    username: text('username').notNull(),
  },
  indexes: [
    { columns: ['email'], unique: true },
    { columns: ['username'] }
  ]
});
```

### Redis Connection Pool

```typescript
import { RedisConnectionPool } from 'drizzle-struct/back-end';

const pool = new RedisConnectionPool({
  host: 'localhost',
  port: 6379
}, {
  maxConnectionsPerTarget: 10
});
```

### Caching

```typescript
import { StructCache } from 'drizzle-struct/back-end';

const cache = new StructCache(userStruct, redis, {
  ttl: 300,
  invalidateOn: ['create', 'update', 'delete']
});
```

### Message Queue

```typescript
import { MessageQueueBridge } from 'drizzle-struct/back-end';

const mqBridge = new MessageQueueBridge(userStruct, {
  amqpUrl: 'amqp://localhost',
  serviceName: 'user-service'
});

await mqBridge.connect();
```

### Telemetry

```typescript
import { StructTelemetry } from 'drizzle-struct/back-end';

const telemetry = new StructTelemetry(userStruct, {
  serviceName: 'user-service',
  metricsEndpoint: 'http://metrics:9090/metrics',
  sampleRate: 0.1
});
```

## Dependencies

New dependencies added:
- `amqplib` - AMQP/RabbitMQ client
- `@types/amqplib` - TypeScript types for amqplib

## Documentation

For detailed documentation including:
- Configuration options for each feature
- Best practices and performance considerations
- Troubleshooting guide
- Integration examples

Please refer to the generated TypeDoc documentation or the inline JSDoc comments in the source files.

## Non-Breaking Changes

All features are opt-in and backwards compatible. Existing code will continue to work without any modifications.
