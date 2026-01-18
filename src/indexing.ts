/* eslint-disable @typescript-eslint/no-explicit-any */
import { SQL } from 'drizzle-orm';

/**
 * Configuration for a database index
 *
 * @export
 * @typedef {IndexConfig}
 */
export type IndexConfig = {
	columns: string[];
	unique?: boolean;
	name?: string;
	where?: SQL;
	type?: 'btree' | 'hash' | 'gin' | 'gist';
};

/**
 * Manages database indexes for a struct
 *
 * @export
 * @class IndexManager
 * @typedef {IndexManager}
 */
export class IndexManager {
	/**
	 * Creates an instance of IndexManager.
	 *
	 * @constructor
	 * @param {string} structName
	 */
	constructor(private structName: string) {}

	/**
	 * Generates SQL for creating an index
	 *
	 * @param {IndexConfig} index
	 * @returns {string}
	 */
	generateIndexSQL(index: IndexConfig): string {
		const indexName = index.name || `${this.structName}_${index.columns.join('_')}_idx`;
		const unique = index.unique ? 'UNIQUE ' : '';
		const method = index.type ? ` USING ${index.type}` : '';
		const cols = index.columns.join(', ');
		const where = index.where ? ` WHERE ${index.where}` : '';

		return `CREATE ${unique}INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON ${this.structName}${method} (${cols})${where};`;
	}

	/**
	 * Creates indexes in the database
	 *
	 * @async
	 * @param {any} database
	 * @param {IndexConfig[]} indexes
	 * @returns {Promise<void>}
	 */
	async createIndexes(database: any, indexes: IndexConfig[]): Promise<void> {
		for (const index of indexes) {
			const sql = this.generateIndexSQL(index);
			try {
				await database.execute(sql);
				console.log(`Created index: ${index.name || index.columns.join('_')}`);
			} catch (error) {
				console.warn(`Index creation warning for ${this.structName}:`, error);
			}
		}
	}
}
