/**
 * Example unit test file demonstrating real database testing
 *
 * This shows how to write unit tests that interact with a real PostgreSQL database
 * using the new testing utilities.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { struct } from './schema';
config();

const { DB_USER, DB_PASS, DB_HOST, DB_PORT, DB_NAME } = process.env;
if (!DB_USER) throw new Error('DB_USER is not defined in environment variables');
if (!DB_PASS) throw new Error('DB_PASS is not defined in environment variables');
if (!DB_HOST) throw new Error('DB_HOST is not defined in environment variables');
if (!DB_PORT) throw new Error('DB_PORT is not defined in environment variables');
if (!DB_NAME) throw new Error('DB_NAME is not defined in environment variables');

const DB = drizzle(
	postgres({
		host: DB_HOST,
		port: parseInt(DB_PORT, 10),
		user: DB_USER,
		password: DB_PASS,
		database: DB_NAME
	})
);


describe.sequential('Struct Real Database Tests', () => {
	const WAIT_TIME = 5000; // ms
	const createTimeout = (message: string) => setTimeout(() => {
		throw new Error(message);
	}, WAIT_TIME);

	beforeAll(async () => {
		const timeout = createTimeout('Database build timed out');
		struct.on('build', () => {
			clearTimeout(timeout);
		});
		await struct.build(DB).unwrap();
		await struct.clear().unwrap();
	});


	afterAll(async () => {
		await struct.clear().unwrap();
		// Clean up database connection
		await DB.$client.end();
	});
	it('Should receive the create event on insert', async () => {
		const timeout = createTimeout('Did not receive create event in time');
		struct.on('create', (record) => {
			clearTimeout(timeout);
			expect(record.data.string).toBe('test');
			expect(record.data.boolean).toBe(true);
			expect(record.data.integer).toBe(40);
			expect(record.data.real).toBe(99.99);
			expect(record.data.char).toBe('A');
			expect(new Date(record.data.timestamp).toISOString()).toBe(new Date('2024-01-01').toISOString());
			expect(record.data.varchar).toBe('test varchar');
			expect(new Date(record.data.date).toISOString()).toBe(new Date('2024-01-01').toISOString());
		});
	});

	it('Should receive the update event on update', async () => {
		const timeout = createTimeout('Did not receive update event in time');
		struct.on('update', ({ from, to }) => {
			clearTimeout(timeout);
			expect(from.string).toBe('test');
			expect(to.data.string).toBe('updated test');
		});
	});
	it('Should receive the delete event on delete', async () => {
		const timeout = createTimeout('Did not receive delete event in time');
		struct.on('delete', (record) => {
			clearTimeout(timeout);
			expect(record.data.string).toBe('test');
		});
	});
	it('Should receive the archive event on archive', async () => {
		const timeout = createTimeout('Did not receive archive event in time');
		struct.on('archive', (record) => {
			clearTimeout(timeout);
			expect(record.data.string).toBe('test');
		});
	});
	it('Should receive the restore event on restore', async () => {
		const timeout = createTimeout('Did not receive restore event in time');
		struct.on('restore', (record) => {
			clearTimeout(timeout);
			expect(record.data.string).toBe('test');
		});
	});
	it('Should receive the delete version event on delete version', async () => {
		const timeout = createTimeout('Did not receive delete version event in time');
		struct.on('delete-version', (version) => {
			clearTimeout(timeout);
			expect(version.data.string).toBe('updated test');
		});
	});
	it('Should receive the restore version event on restore version', async () => {
		const timeout = createTimeout('Did not receive restore version event in time');
		struct.on('restore-version', (version) => {
			clearTimeout(timeout);
			expect(version.data.string).toBe('test');
		});
	});

	let data: typeof struct.sample | undefined;


	it('should insert and retrieve a new record', async () => {
		const inserted = await struct.new({
			string: 'test',
			boolean: true,
			integer: 40,
			real: 99.99,
			char: 'A',
			timestamp: new Date('2024-01-01'),
			varchar: 'test varchar',
			date: new Date('2024-01-01').toISOString(),
			// pgEnum: 'option1',
		}).unwrap();

		data = inserted;
	});

	it('Should retrieve the inserted record by ID', async () => {
		if (!data) throw new Error('No data inserted from create test');
		const record = await struct.fromId(data.id).unwrap();
		expect(record).toBeDefined();
		if (!record) throw new Error('Record not found'); // For TypeScript type narrowing
		expect(record.data.string).toBe('test');
		expect(record.data.boolean).toBe(true);
		expect(record.data.integer).toBe(40);
		expect(record.data.real).toBe(99.99);
		expect(record.data.char).toBe('A');
		expect(new Date(record.data.timestamp).toISOString()).toBe(new Date('2024-01-01').toISOString());
		expect(record.data.varchar).toBe('test varchar');
		expect(new Date(record.data.date).toISOString()).toBe(new Date('2024-01-01').toISOString());
		// expect(record.pgEnum).toBe('option1');
	});

	it('Should update the record', async () => {
		if (!data) throw new Error('No data inserted from create test');
		const updated = await data.update({
			string: 'updated test'
		}).unwrap();
		expect(updated?.data.string).toBe('updated test');
	});

	it('Should create, restore, and delete a version', async () => {
		if (!data) throw new Error('No data inserted from create test');
		const versions = await data.getVersions().unwrap();
		expect(versions.length).toBe(1);
		const [version] = versions;
		expect(version.data.string).toBe('test'); // Original value
		await version.restore().unwrap();
		const updatedVersions = await data.getVersions().unwrap();
		expect(updatedVersions.length).toBe(1);
		const [restoredVersion] = updatedVersions;
		await restoredVersion.delete().unwrap();
	});

	it('Should archive and restore the record', async () => {
		if (!data) throw new Error('No data inserted from create test');
		await data.setArchive(true).unwrap();
		expect(data.archived).toBe(true);
		await data.setArchive(false).unwrap();
		expect(data.archived).toBe(false);
	});

	it('Should update attributes', async () => {
		if (!data) throw new Error('No data inserted from create test');
		await data.setAttributes(['test-attribute']).unwrap();
		const attrs = data.getAttributes().unwrap();
		expect(attrs).toContain('test-attribute');
		await data.addAttributes('another-attribute').unwrap();
		const updatedAttrs = data.getAttributes().unwrap();
		expect(updatedAttrs).toContain('another-attribute');
		await data.removeAttributes('test-attribute').unwrap();
		const finalAttrs = data.getAttributes().unwrap();
		expect(finalAttrs).not.toContain('test-attribute');
	});

	it('Should delete the record', async () => {
		if (!data) throw new Error('No data inserted from create test');
		await data.delete().unwrap();
		await struct.fromId(data.id).unwrap();
	});
});