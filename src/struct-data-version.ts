/* eslint-disable @typescript-eslint/no-explicit-any */
import { sql } from 'drizzle-orm';
import { attempt, attemptAsync } from 'ts-utils/check';
import { OnceReadMap } from 'ts-utils/map';
import {
	type Blank,
	type Struct,
	type Structable,
	globalCols,
	versionGlobalCols,
	type SafeReturn
} from './struct';
import { StructError, DataError } from './utils';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

/**
 * A version of the data
 *
 * @export
 * @class DataVersion
 * @typedef {DataVersion}
 * @template {Blank} T
 * @template {string} Name
 */
export class DataVersion<T extends Blank = any, Name extends string = any> {
	/**
	 * This is a local metadata map, it is not saved in the database and is designed to be short-lived
	 *
	 * @public
	 * @readonly
	 * @type {*}
	 */
	public readonly metadata = new OnceReadMap<string, string | boolean | number>();

	/**
	 * Creates an instance of DataVersion.
	 *
	 * @constructor
	 * @param {Struct<T, Name>} struct
	 * @param {Structable<T & typeof globalCols & typeof versionGlobalCols>} data
	 */
	constructor(
		public readonly struct: Struct<T, Name>,
		public readonly data: Structable<T & typeof globalCols & typeof versionGlobalCols>
	) {}

	/**
	 * Primary key for this data, vhId is unique across all versions of all data
	 *
	 * @readonly
	 * @type {TsType<(T & { id: any; created: any; updated: any; archived: any; universes: any; attributes: any; lifetime: any; } & { vhId: any; id: any; vhCreated: any; })[string]["_"]["dataType"]>}
	 */
	get vhId(): string {
		return this.data.vhId;
	}

	/**
	 * Id of the data, you can have multiple of the same data because it can have multiple versions.
	 *
	 * @readonly
	 * @type {TsType<(T & { id: any; created: any; updated: any; archived: any; universes: any; attributes: any; lifetime: any; } & { vhId: any; id: any; vhCreated: any; })[string]["_"]["dataType"]>}
	 */
	get id(): string {
		return this.data.id;
	}

	/**
	 * The date the data was created
	 *
	 * @readonly
	 * @type {*}
	 */
	get created(): Date {
		return this.data.created;
	}

	/**
	 * The date the data was last updated
	 *
	 * @readonly
	 * @type {*}
	 */
	get updated(): Date {
		return this.data.updated;
	}

	/**
	 * If the data is archived
	 *
	 * @readonly
	 * @type {TsType<(T & { id: any; created: any; updated: any; archived: any; universes: any; attributes: any; lifetime: any; } & { vhId: any; id: any; vhCreated: any; })[string]["_"]["dataType"]>}
	 */
	get archived(): boolean {
		return this.data.archived;
	}

	/**
	 * The date this version was created
	 *
	 * @readonly
	 * @type {*}
	 */
	get vhCreated(): Date {
		return new Date(this.data.vhCreated);
	}

	/**
	 * A reference to the database this data is stored in
	 *
	 * @readonly
	 * @type {PostgresJsDatabase}
	 */
	get database(): PostgresJsDatabase {
		return this.struct.database;
	}

	/**
	 * Deletes this version of the data
	 *
	 * @param {?{
	 *         emit?: boolean;
	 *     }} [config]
	 * @returns {*}
	 */
	delete(
		config: {
			emit?: boolean;
			source?: string;
		} = {
			emit: true,
			source: 'self'
		}
	) {
		return attemptAsync(async () => {
			if (!this.struct.versionTable)
				throw new StructError(
					this.struct,
					`Struct ${this.struct.name} does not have a version table`
				);
			if (this.struct.data.proxyClient) {
				const res = await this.struct.data.proxyClient
					.deleteVersion(this.struct, this.vhId)
					.unwrap();
				this.struct.emit('delete-version', this);
				return res;
			}
			await this.database
				.delete(this.struct.versionTable)
				.where(sql`${this.struct.versionTable.vhId} = ${this.vhId}`);
			if (config.emit === false) this.metadata.set('no-emit', true);
			if (config.source) this.metadata.set('source', config.source);
			this.struct.emit('delete-version', this);
			this.log('Deleted');
		});
	}

	/**
	 * Restores this version of the data, it will emit both a restore-version event and an update event
	 *
	 * @param {?{
	 *         emit?: boolean;
	 *     }} [config]
	 * @returns {*}
	 */
	restore(
		config: {
			emit?: boolean;
			source?: string;
		} = {
			emit: true,
			source: 'self'
		}
	) {
		return attemptAsync(async () => {
			if (this.struct.data.proxyClient) {
				const res = await this.struct.data.proxyClient
					.restoreVersion(this.struct, this.vhId)
					.unwrap();
				this.struct.emit('restore-version', this);
				return res;
			}

			const data = (await this.struct.fromId(this.id)).unwrap();
			if (!data) this.struct.new(this.data);
			else await data.update(this.data);
			if (config.emit === false) this.metadata.set('no-emit', true);
			if (config.source) this.metadata.set('source', config.source);
			this.struct.emit('restore-version', this);
			this.log('Restored');
		});
	}

	/**
	 * Logs an event to the console
	 *
	 * @param {...unknown[]} data
	 */
	log(...data: unknown[]) {
		// this.struct.log(chalk.magenta(`${this.id}`), chalk.green(`(${this.vhId})`), ...data);
		this.struct.log(
			// magenta
			'\x1b[35m',
			`${this.id}`,
			// green
			'\x1b[32m',
			`(${this.vhId})`,
			// reset
			'\x1b[0m',
			...data
		);
	}

	/**
	 * Gets all attributes of the data, this is a JSON string that is parsed into an array of strings.
	 *
	 * @returns {*}
	 */
	getAttributes() {
		return attempt(() => {
			const a = JSON.parse(this.data.attributes);
			if (!Array.isArray(a)) throw new DataError(this.struct, 'Attributes must be an array');
			if (!a.every((i) => typeof i === 'string'))
				throw new DataError(this.struct, 'Attributes must be an array of strings');
			return a;
		});
	}

	/**
	 * Returns a safe object of the data, omitting columns that you want removed.
	 * This isn't typed properly yet, so don't trust the omit types yet.
	 *
	 * @param {?(keyof T & keyof typeof globalCols)[]} [omit]
	 * @returns {SafeReturn<T, Keys>}
	 * @template {keyof T & keyof typeof globalCols} Keys
	 * @template {T & typeof globalCols} T
	 * @example
	 * const data = struct.fromId('id').unwrap();
	 * const safeData = data.safe('id', 'created'); // This will return the data without the id and created columns
	 */
	safe<Keys extends (keyof (T & typeof globalCols))[]>(...omit: Keys): SafeReturn<T, Keys> {
		// TODO: Type the omitted columns properly
		const data = { ...this.data }; // copy
		if (!omit) omit = [] as any;

		// Merge omitted keys with safes
		(omit as any).push(...(this.struct.data.safes || []));

		for (const key of omit) {
			delete (data as any)[key];
		}
		for (const key in data) {
			if (data[key] instanceof Date) {
				// Convert dates to ISO strings
				(data as any)[key] = (data[key] as Date).toISOString();
			}
		}
		return data as any;
	}

	/**
	 * Returns the data without omitting the global safe keys.
	 * This is unsafe because it can return data that is not safe to send to the client
	 * @returns {SafeReturn<T, []>}
	 */
	unsafe<Keys extends (keyof (T & typeof globalCols))[]>(omit: Keys): SafeReturn<T, Keys> {
		// This is a method to return the data without any safes or omitted keys
		// It is unsafe because it can return data that is not safe to send to the client
		const data = { ...this.data }; // copy
		if (!omit) omit = [] as any;

		for (const key of omit) {
			delete (data as any)[key];
		}
		for (const key in data) {
			if (data[key] instanceof Date) {
				// Convert dates to ISO strings
				(data as any)[key] = (data[key] as Date).toISOString();
			}
		}
		return data as any;
	}
}
