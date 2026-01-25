/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Testing utilities for drizzle-struct
 *
 * This module provides helper functions and utilities for writing unit tests
 * that interact with real database instances.
 */

import { type Struct } from './struct';
import { type StructData } from './struct-data';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

/**
 * Test database connection pool
 * Shared across tests for efficiency
 */
let testDb: PostgresJsDatabase | null = null;
let testSql: ReturnType<typeof postgres> | null = null;

/**
 * Creates a test database connection using environment variables
 * Uses PGHOST, PGUSER, PGDATABASE, PGPORT, PGPASSWORD from .env
 */
export function getTestDb(): PostgresJsDatabase {
	if (testDb) {
		return testDb;
	}

	// Build connection string with proper URL encoding for password
	const host = process.env.PGHOST || 'localhost';
	const user = process.env.PGUSER || 'postgres';
	const password = encodeURIComponent(process.env.PGPASSWORD || 'postgres');
	const port = process.env.PGPORT || '5432';
	const database = process.env.PGDATABASE || 'drizzle_struct_test';

	const connectionString = `postgres://${user}:${password}@${host}:${port}/${database}`;

	testSql = postgres(connectionString, {
		max: 10,
		idle_timeout: 20,
		connect_timeout: 10
	});

	testDb = drizzle(testSql);
	return testDb;
}

/**
 * Closes the test database connection
 * Should be called after all tests complete
 */
export async function closeTestDb(): Promise<void> {
	if (testSql) {
		await testSql.end();
		testSql = null;
		testDb = null;
	}
}

/**
 * Clears all data from a struct's table
 * Useful for test cleanup between test cases
 */
export async function clearStructTable<T extends Record<string, any>, Name extends string>(
	struct: Struct<T, Name>
): Promise<void> {
	const db = getTestDb();
	await db.delete(struct.table);
}

/**
 * Creates test data in a struct's table
 * Returns a ResultPromise that resolves to the created StructData instance
 *
 * Usage: const data = await createTestData(struct, { name: 'Test' }).unwrap();
 */
export function createTestData<T extends Record<string, any>, Name extends string>(
	struct: Struct<T, Name>,
	data: Partial<T>
) {
	return struct.new(data as any);
}

/**
 * Checks if a struct has any data
 */
export async function hasData<T extends Record<string, any>, Name extends string>(
	struct: Struct<T, Name>
): Promise<boolean> {
	const result = await struct.all({ type: 'array', limit: 1, offset: 0 }).unwrap();
	return result.length > 0;
}

/**
 * Gets the count of records in a struct's table
 */
export async function getRecordCount<T extends Record<string, any>, Name extends string>(
	struct: Struct<T, Name>
): Promise<number> {
	const result = await struct.all({ type: 'all' }).unwrap();
	return result.length;
}

/**
 * Test lifecycle hooks
 */
export const testHooks = {
	/**
	 * Called before all tests
	 */
	beforeAll: async () => {
		// Ensure database connection is ready
		getTestDb();
	},

	/**
	 * Called after all tests
	 */
	afterAll: async () => {
		await closeTestDb();
	},

	/**
	 * Called before each test
	 */
	beforeEach: async <T extends Record<string, any>, Name extends string>(
		structs: Struct<T, Name>[]
	) => {
		// Clear all struct tables before each test
		for (const struct of structs) {
			await clearStructTable(struct);
		}
	},

	/**
	 * Called after each test
	 */
	afterEach: async () => {
		// Cleanup can be added here if needed
	}
};

/**
 * Legacy compatibility - these functions are no-ops now
 * Tests should use real database instead of in-memory tables
 */

export const isTesting = (_struct: Struct<any, any>): boolean => {
	// Always return false - we don't use test tables anymore
	return false;
};

export const noTableError = (struct: Struct<any, any>) => {
	return new Error(`No table found for struct: ${struct.data.name}`);
};

export const noDataError = (structData: StructData<any, any>) => {
	return new Error(`No data with ${structData.id} found in table ${structData.struct.name}`);
};

// Legacy exports for backwards compatibility
export const startTesting = () => {
	console.warn('startTesting() is deprecated. Use real database tests instead.');
};

export const endTesting = () => {
	console.warn('endTesting() is deprecated. Use real database tests instead.');
};

export class TestTable {
	static tables = new Map();
	static get(_name: string) {
		// Return null to indicate testing mode is disabled
		return null;
	}
}
