# Testing Guide

## Overview

The testing infrastructure has been restructured to use real database connections instead of in-memory test tables. This provides more accurate testing that reflects actual production behavior.

## Setup

### Prerequisites

1. PostgreSQL database running (version 14 or higher recommended)
2. Environment variables configured in `.env` file:

```bash
PGHOST=localhost
PGUSER=postgres
PGDATABASE=drizzle_struct_test
PGPORT=5432
PGPASSWORD=your_password
```

### Running Tests

```bash
# Run all unit tests
pnpm test:unit

# Run tests in watch mode
pnpm test
```

## Writing Tests

### Basic Test Structure

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
	getTestDb,
	closeTestDb,
	clearStructTable,
	createTestData,
	hasData,
	getRecordCount
} from './testing';
import { yourStruct } from './your-struct-definition';

describe('Your Struct Tests', () => {
	beforeAll(async () => {
		// Database connection is automatically established
		getTestDb();
	});

	afterAll(async () => {
		// Clean up database connection
		await closeTestDb();
	});

	beforeEach(async () => {
		// Clear test data before each test
		await clearStructTable(yourStruct);
	});

	it('should create a new record', async () => {
		const data = await createTestData(yourStruct, {
			name: 'Test Name',
			email: 'test@example.com'
		});

		expect(data).toBeDefined();
		expect(await hasData(yourStruct)).toBe(true);
	});

	it('should query records', async () => {
		// Create test data
		await createTestData(yourStruct, { name: 'Test' });

		// Query the data
		const all = await yourStruct.all({ type: 'array', limit: 10, offset: 0 }).unwrap();

		expect(all.length).toBe(1);
	});
});
```

## Testing Utilities

### `getTestDb()`

Returns a connection to the test database. Uses environment variables for configuration.

### `closeTestDb()`

Closes the test database connection. Should be called in `afterAll` hooks.

### `clearStructTable(struct)`

Removes all data from a struct's table. Useful for cleaning up between tests.

### `createTestData(struct, data)`

Creates a new record in the struct's table. Returns the created StructData instance.

### `hasData(struct)`

Returns `true` if the struct has any data, `false` otherwise.

### `getRecordCount(struct)`

Returns the number of records in the struct's table.

## Migration from Old Testing System

The old in-memory test table system (`TestTable`, `startTesting()`, `endTesting()`) is now deprecated. Tests should interact with a real database.

### Changes Required

1. **Remove** calls to `startTesting()` and `endTesting()`
2. **Remove** in-memory test table setup code
3. **Add** proper database setup/teardown in test hooks
4. **Update** tests to use real database operations

### Example Migration

**Before (In-Memory):**

```typescript
startTesting({
	timeout: 5000,
	structs: [myStruct],
	maxRows: 100,
	log: false
});

// Tests run against in-memory tables
const data = myStruct.new({ name: 'Test' });

endTesting({ structs: [myStruct] });
```

**After (Real Database):**

```typescript
describe('MyStruct Tests', () => {
	beforeEach(async () => {
		await clearStructTable(myStruct);
	});

	it('should create data', async () => {
		const data = await createTestData(myStruct, { name: 'Test' });
		expect(data).toBeDefined();
	});
});
```

## Continuous Integration

The GitHub Actions workflows automatically:

- Spin up a PostgreSQL 16 service container
- Configure environment variables
- Run all tests against the real database

See `.github/workflows/test.yml` for the full configuration.

## Tips

1. **Always clean up** test data in `beforeEach` or `afterEach` hooks
2. **Use transactions** (if needed) to isolate tests
3. **Avoid hardcoding** database connection details - use environment variables
4. **Test edge cases** with real database constraints
5. **Check for database errors** in test assertions

## Troubleshooting

### Connection Errors

If you see connection errors, verify:

- PostgreSQL is running
- Environment variables are set correctly
- Database exists
- User has proper permissions

### Slow Tests

- Use `beforeEach` to clean up only what's needed
- Consider database indexing for large test datasets
- Use transactions to speed up test cleanup

### Test Isolation Issues

- Always clean up test data in hooks
- Use unique identifiers for test data
- Avoid relying on execution order between tests
