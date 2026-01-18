/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Complete example showing how to use all 5 production features together
 */

import { 
  Struct, 
  RedisConnectionPool, 
  StructCache, 
  MessageQueueBridge, 
  StructTelemetry 
} from '../src/back-end';
import { text, integer } from 'drizzle-orm/pg-core';
import { Redis } from 'redis-utils';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

// Define a user struct with all production features
const userStruct = new Struct({
  name: 'users',
  structure: {
    email: text('email').notNull(),
    username: text('username').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    age: integer('age')
  },
  // Feature 1: Database Indexes
  indexes: [
    { columns: ['email'], unique: true, name: 'users_email_unique_idx' },
    { columns: ['username'], name: 'users_username_idx' },
    { columns: ['firstName', 'lastName'], name: 'users_name_idx' }
  ],
  log: true
});

async function main() {
  // Setup database connection
  const queryClient = postgres(process.env.DATABASE_URL || 'postgres://localhost:5432/mydb');
  const db = drizzle(queryClient);

  // Build the struct (this will create indexes automatically)
  await userStruct.build(db);

  // Feature 2: Redis Connection Pool
  const redisPool = new RedisConnectionPool({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    db: 0
  }, {
    maxConnectionsPerTarget: 10,
    minConnectionsPerTarget: 2,
    healthCheckInterval: 10000
  });

  // Monitor pool events
  redisPool.on('connection:creating', ({ target }) => {
    console.log(`Creating connection for ${target}`);
  });

  redisPool.on('connection:unhealthy', ({ poolKey }) => {
    console.warn(`Unhealthy connection detected: ${poolKey}`);
  });

  // Get a Redis instance for caching
  const redis = await redisPool.acquire('cache-service');

  // Feature 3: Query Result Caching
  const cache = new StructCache(userStruct, redis as any, {
    ttl: 300, // 5 minutes
    invalidateOn: ['create', 'update', 'delete', 'archive', 'restore']
  });

  // Subscribe to cache invalidations (important for multi-instance deployments)
  await cache.subscribeToInvalidations();

  // Feature 4: Message Queue Integration
  const mqBridge = new MessageQueueBridge(userStruct, {
    amqpUrl: process.env.AMQP_URL || 'amqp://localhost',
    serviceName: 'user-service',
    durable: true
  });

  try {
    await mqBridge.connect();
    console.log('Connected to message queue');

    // Setup dead letter queue for failed messages
    await mqBridge.setupDLQ();

    // Consume events from other services
    await mqBridge.consume(async (event) => {
      console.log(`Received ${event.type} event from ${event.source}`);
      
      if (event.type === 'create') {
        console.log('New user created:', event.data.id);
      }
    }, {
      prefetch: 10,
      routingPattern: 'users.*'
    });
  } catch (error) {
    console.error('Message queue setup failed:', error);
  }

  // Feature 5: Telemetry & Metrics
  const telemetry = new StructTelemetry(userStruct, {
    serviceName: 'user-service',
    metricsEndpoint: process.env.METRICS_ENDPOINT,
    tracesEndpoint: process.env.TRACES_ENDPOINT,
    sampleRate: 0.1 // Sample 10% of operations
  });

  // Example: Create a user with all features working together
  async function createUser(email: string, username: string, firstName: string, lastName: string) {
    // Start a trace span
    const spanId = telemetry.startSpan('user.create');
    
    try {
      telemetry.addSpanEvent(spanId, 'validation-start');
      
      // Validate user doesn't exist (with caching)
      const cacheKey = cache.generateCacheKey('fromEmail', { email });
      const existingUser = await cache.get(
        cacheKey,
        async () => {
          return await userStruct.fromProperty('email', email).unwrap();
        }
      );

      if (existingUser) {
        throw new Error('User already exists');
      }

      telemetry.addSpanEvent(spanId, 'creating-user');
      
      // Create user (this will automatically publish to message queue)
      const user = await userStruct.new({
        email,
        username,
        firstName,
        lastName,
        age: 25
      }).unwrap();

      telemetry.addSpanEvent(spanId, 'user-created');
      
      // Cache will be automatically invalidated due to 'create' event
      
      telemetry.endSpan(spanId, { status: 'success' });
      
      console.log('User created:', user.id);
      return user;
      
    } catch (error: any) {
      telemetry.endSpan(spanId, { status: 'error', error: error.message });
      throw error;
    }
  }

  // Example: Get user with caching
  async function getUser(id: string) {
    const spanId = telemetry.startSpan('user.get');
    
    try {
      const cacheKey = cache.generateCacheKey('fromId', { id });
      const user = await cache.get(
        cacheKey,
        async () => {
          const result = await userStruct.fromId(id).unwrap();
          if (!result) throw new Error('User not found');
          return result;
        }
      );

      telemetry.endSpan(spanId, { status: 'success', cached: true });
      return user;
      
    } catch (error: any) {
      telemetry.endSpan(spanId, { status: 'error', error: error.message });
      throw error;
    }
  }

  // Example usage
  try {
    const user = await createUser(
      'john.doe@example.com',
      'johndoe',
      'John',
      'Doe'
    );

    console.log('Created user:', user.id);

    // Get user (will be cached)
    const cachedUser = await getUser(user.id);
    console.log('Got user from cache:', cachedUser.id);

    // Get statistics
    console.log('Cache stats:', cache.getStats());
    console.log('Pool stats:', redisPool.getStats());
    console.log('Telemetry stats:', telemetry.getStats());

  } catch (error) {
    console.error('Error:', error);
  }

  // Cleanup on shutdown
  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    
    telemetry.destroy();
    await mqBridge.close();
    await redisPool.destroy();
    await queryClient.end();
    
    console.log('Cleanup complete');
    process.exit(0);
  });
}

// Run the example
if (require.main === module) {
  main().catch(console.error);
}

export { userStruct, main };
