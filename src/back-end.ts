/* eslint-disable @typescript-eslint/no-explicit-any */
import { pgTable, text, boolean, integer, timestamp } from 'drizzle-orm/pg-core';
import type { PgColumnBuilderBase, PgTableWithColumns } from 'drizzle-orm/pg-core';
import { count, SQL, sql, type BuildColumns } from 'drizzle-orm';
import { attempt, attemptAsync, resolveAll, type Result, ResultPromise } from 'ts-utils/check';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { type ColumnDataType } from 'drizzle-orm';
import { ComplexEventEmitter } from 'ts-utils/event-emitter';
import { Loop } from 'ts-utils/loop';
import { Stream } from 'ts-utils/stream';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { DataAction, PropertyAction } from './types';
import { OnceReadMap } from 'ts-utils/map';
import { log } from './utils';
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import { RedisStructProxyClient, RedisStructProxyServer } from './redis-struct-proxy';
import { isTesting, noDataError, noTableError, TestTable } from './testing';


let hasRunFrontendWarn = false;
const runFrontendWarn = () => {
	if (hasRunFrontendWarn) return;
	hasRunFrontendWarn = true;
	console.warn(
		chalk.yellow(
			'WARNING:',
		),
		'All frontend features, such as sendListen, queryListen, and callListen, block, bypass, frontend, etc. will be going away in the future.\n\n',
		'Use or build other services that will run these systems.'
	);
};

/**
 * Error thrown for invalid struct state
 *
 * @export
 * @class StructError
 * @typedef {StructError}
 * @extends {Error}
 */
export class StructError extends Error {
	/**
	 * Creates an instance of StructError.
	 *
	 * @constructor
	 * @param {string} message
	 */
	constructor(struct: Struct, message: string) {
		super(message);
		this.name = `StructError [${struct.name}]`;
		struct.emit('error', this);
	}
}

/**
 * Error thrown for a fatal struct state - this should crash the program
 *
 * @export
 * @class FatalStructError
 * @typedef {FatalStructError}
 * @extends {Error}
 */
export class FatalStructError extends Error {
	/**
	 * Creates an instance of FatalStructError.
	 *
	 * @constructor
	 * @param {string} message
	 */
	constructor(struct: Struct, message: string) {
		super(message);
		this.name = `FatalStructError [${struct.name}]`;
		struct.emit('error', this);
	}
}

/**
 * Error thrown for invalid data state
 *
 * @export
 * @class DataError
 * @typedef {DataError}
 * @extends {Error}
 */
export class DataError extends Error {
	/**
	 * Creates an instance of DataError.
	 *
	 * @constructor
	 * @param {string} message
	 */
	constructor(struct: Struct, message: string) {
		super(message);
		this.name = `DataError [${struct.name}]`;
		struct.emit('error', this);
	}
}

/**
 * Error thrown for a fatal data state - this should crash the program
 *
 * @export
 * @class FatalDataError
 * @typedef {FatalDataError}
 * @extends {Error}
 */
export class FatalDataError extends Error {
	/**
	 * Creates an instance of FatalDataError.
	 *
	 * @constructor
	 * @param {string} message
	 */
	constructor(struct: Struct, message: string) {
		super(message);
		this.name = `FatalDataError [${struct.name}]`;
		struct.emit('error', this);
	}
}

// export class StructStatus {
//     constructor(
//         public readonly struct: Struct,
//         public readonly code: ServerCode,
//         public readonly message: string
//     ) {

//     }

//     json() {

//     }
// }

/**
 * Status of a struct operation
 *
 * @typedef {StructStatus}
 */
type StructStatus = {
	success: boolean;
	message?: string;
	data?: unknown;
};

/**
 * Blank struct structure
 *
 * @export
 * @typedef {Blank}
 */
export type Blank = Record<string, PgColumnBuilderBase>;

/**
 * Config for a struct
 *
 * @export
 * @typedef {StructBuilder}
 * @template {Blank} T
 * @template {string} Name
 */
export type StructBuilder<T extends Blank, Name extends string> = {
	/**
	 * Struct name, this is used for the table name in postgres and how the client/server know what struct to use
	 */
	name: Name;
	/**
	 * Struct structure, this is the data that will be stored in the database
	 */
	structure: T;
	/**
	 * If this is a sample struct, that means it's only used for examples and will not be built
	 */
	sample?: boolean;
	/**
	 * Generate a loop that will iterate over all data in this struct (use carefully)
	 */
	loop?: {
		fn: (data: StructData<T, Name>, index: number) => void;
		time: number;
	};
	/**
	 * If this struct is meant to communicate with a front-end struct
	 */
	frontend?: boolean;
	/**
	 * Configure how you want global columns to be generated
	 */
	generators?: Partial<
		{
			[key in keyof T]: (data: Structable<T>) => TsType<T[key]['_']['dataType']>;
		} & {
			id: (data: Structable<T>) => string;
			attributes: (data: Structable<T>) => string[];
			// universes: () => string[];
			universe: (data: Structable<T>) => string;
			canUpdate: (data: Structable<T>) => boolean;
		}
	>;
	lifetime?: number;
	/**
	 * Version history, if a data is updated, it will save the current state to a version table
	 * If not set, there will be no version table
	 */
	versionHistory?: {
		type: 'days' | 'versions';
		amount: number;
	};

	/**
	 * Log events to the console
	 */
	log?: boolean;

	safes?: (keyof (T & typeof globalCols))[];

	validators?: {
		[key in keyof T]?: z.ZodType<T[key]['_']['dataType']> | ((data: unknown) => boolean);
	};

	/**
	 * If you want to proxy this struct through a different microservice
	 * If you do this, you cannot expose this struct's table(s) directly to drizzle-orm.
	 * You cannot share a database between different microservices where both have different structs, so use this if you want to share state between different microservices.
	 */
	proxyClient?: RedisStructProxyClient<string, string>;

	/**
	 * Sets up the host for the data for other microservices to connect to
	 */
	proxyServer?: RedisStructProxyServer<string>;
};

/**
 * Simple type for what the struct outputs
 *
 * @export
 * @typedef {Data}
 * @template {Struct<Blank, string>} T
 */
export type Data<T extends Struct<Blank, string>> = T['sample'];

/**
 * All global columns which will be applied to every data on the struct
 *
 * @type {{ id: any; created: any; updated: any; archived: any; universes: any; attributes: any; lifetime: any; }}
 */
export const globalCols = {
	id: text('id').primaryKey(),
	created: timestamp('created', { withTimezone: true}).notNull(),
	updated: timestamp('updated', { withTimezone: true}).notNull(),
	archived: boolean<'archived'>('archived').default(false).notNull(),
	attributes: text('attributes').notNull(),
	lifetime: integer('lifetime').notNull(),
	canUpdate: boolean<'can_update'>('can_update').default(true).notNull()
};

/**
 * Postgres table type taking the structure and the name
 *
 * @export
 * @typedef {Table}
 * @template {Blank} T
 * @template {string} TableName
 */
export type Table<T extends Blank, TableName extends string> = PgTableWithColumns<{
	name: TableName;
	schema: undefined;
	columns: BuildColumns<TableName, T, 'pg'>;
	dialect: 'pg';
}>;

/**
 * A shallow object that is a single row in the database. By default, this does not include the global columns.
 *
 * @export
 * @typedef {Structable}
 * @template {Blank} T
 */
export type Structable<T extends Blank> = {
	[K in keyof T]: TsType<T[K]['_']['dataType']>; // | TsType<T[K]['config']['dataType']>;
};


export type SafeStructable<T extends Blank> = {
	[K in keyof T]: SafeTsType<T[K]['_']['dataType']>;
}

export type SafeReturn<T extends Blank, Keys extends (keyof T)[]> = Readonly<
		Omit<
			SafeStructable<T & typeof globalCols>,
			Keys[number] // | (this["struct"]["data"]["safes"] extends (keyof T)[] ? this["struct"]["data"]["safes"][number] : never)
		>
	>;


/**
 * A stream of StructData
 *
 * @export
 * @class StructStream
 * @typedef {StructStream}
 * @template {Blank} [T=Blank]
 * @template {string} [Name=string]
 * @extends {Stream<StructData<T, Name>>}
 */
export class StructStream<T extends Blank = Blank, Name extends string = string> extends Stream<
	StructData<T, Name>
> {
	/**
	 * Creates an instance of StructStream.
	 *
	 * @constructor
	 * @param {Struct<T, Name>} struct
	 */
	constructor(public readonly struct: Struct<T, Name>) {
		super();
	}
}

/**
 * The version history columns which will be applied to every version of the data on the struct
 *
 * @type {{ vhId: any; id: any; vhCreated: any; }}
 */
export const versionGlobalCols = {
	vhId: text('vh_id').primaryKey(),
	id: text('id').notNull(), // Used to overwrite the other primary key
	vhCreated: text('vh_created').notNull()
};

/**
 * A version of the data
 *
 * @export
 * @class DataVersion
 * @typedef {DataVersion}
 * @template {Blank} T
 * @template {string} Name
 */
export class DataVersion<T extends Blank, Name extends string> {
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
	get vhId() {
		return this.data.vhId;
	}

	/**
	 * Id of the data, you can have multiple of the same data because it can have multiple versions.
	 *
	 * @readonly
	 * @type {TsType<(T & { id: any; created: any; updated: any; archived: any; universes: any; attributes: any; lifetime: any; } & { vhId: any; id: any; vhCreated: any; })[string]["_"]["dataType"]>}
	 */
	get id() {
		return this.data.id;
	}

	/**
	 * The date the data was creaed
	 *
	 * @readonly
	 * @type {*}
	 */
	get created() {
		return this.data.created;
	}

	/**
	 * The date the data was last updated
	 *
	 * @readonly
	 * @type {*}
	 */
	get updated() {
		return this.data.updated;
	}

	/**
	 * If the data is archived
	 *
	 * @readonly
	 * @type {TsType<(T & { id: any; created: any; updated: any; archived: any; universes: any; attributes: any; lifetime: any; } & { vhId: any; id: any; vhCreated: any; })[string]["_"]["dataType"]>}
	 */
	get archived() {
		return this.data.archived;
	}

	/**
	 * The date this version was created
	 *
	 * @readonly
	 * @type {*}
	 */
	get vhCreated() {
		return new Date(this.data.vhCreated);
	}

	/**
	 * A reference to the database this data is stored in
	 *
	 * @readonly
	 * @type {PostgresJsDatabase}
	 */
	get database() {
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
				return this.struct.data.proxyClient.deleteVersion(this.struct, this.vhId).unwrap();
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
				return this.struct.data.proxyClient.restoreVersion(this.struct, this.vhId).unwrap();
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
		this.struct.log(chalk.magenta(`${this.id}`), chalk.green(`(${this.vhId})`), ...data);
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
}

/**
 * A single datapoint in the struct
 *
 * @export
 * @class StructData
 * @typedef {StructData}
 * @template {Blank} [T=any]
 * @template {string} [Name=any]
 */
export class StructData<T extends Blank = any, Name extends string = any> {
	// Used only for local handling
	// Will not be transmitted to the front end
	// Will not be saved in the database
	// Can be used to inform event emitters where the source of the data is
	// This is meant to be short lived
	/**
	 * Metadata map, this is not saved in the database and is designed to be short-lived
	 * Generally only to inform event emitters where the source of the data is
	 * Each point in the map can only be read once
	 *
	 * @public
	 * @readonly
	 * @type {*}
	 */
	public readonly metadata = new OnceReadMap<string, string | boolean | number>();

	/**
	 * Creates an instance of StructData.
	 *
	 * @constructor
	 * @param {Readonly<Structable<T & typeof globalCols>>} data
	 * @param {Struct<T, Name>} struct
	 */
	constructor(
		public readonly data: Readonly<Structable<T & typeof globalCols>>,
		public readonly struct: Struct<T, Name>
	) {}

	/**
	 * Id of the data, this is unique across all data in the struct
	 *
	 * @readonly
	 * @type {*}
	 */
	get id() {
		return this.data.id;
	}

	/**
	 * Date the data was created
	 *
	 * @readonly
	 * @type {*}
	 */
	get created() {
		return this.data.created;
	}

	/**
	 * Date the data was last updated
	 *
	 * @readonly
	 * @type {*}
	 */
	get updated() {
		return this.data.updated;
	}

	/**
	 * If the data is archived
	 *
	 * @readonly
	 * @type {*}
	 */
	get archived() {
		return this.data.archived;
	}

	/**
	 * Reference to the database this data is stored in
	 *
	 * @readonly
	 * @type {PostgresJsDatabase}
	 */
	get database() {
		return this.struct.database;
	}

	/**
	 * How long this data should be stored in the database
	 *
	 * @readonly
	 * @type {*}
	 */
	get lifetime() {
		return this.data.lifetime;
	}

	/**
	 * Gets whether the data can be updated or not (static property when created)
	 *
	 * @readonly
	 * @type {*}
	 */
	get canUpdate() {
		return this.data.canUpdate;
	}

	/**
	 * Updates the data, this will emit an update event. If there is a version table, it will also make a version of the data of the state before the update
	 *
	 * @param {Partial<Structable<T>>} data
	 * @param {?{
	 *         emit?: boolean;
	 *     }} [config]
	 * @returns {*}
	 */
	update(
		data: Partial<Structable<T>>,
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
				return this.struct.data.proxyClient.update(this.struct, this.id, data).unwrap();
			}
			if (!this.canUpdate) {
				throw new DataError(this.struct, 'Cannot change static data');
			}
			const prev = { ...this.data };
			const now = new Date();
			const res = this.struct.validate(
				{
					...this.data,
					...data
				},
				{
					optionals: Object.keys({
						...globalCols,
						...this.data
					}) as string[]
				}
			);
			if (!res.success) {
				throw new DataError(this.struct, `Invalid Data received: ${res.reason}`);
			}
			this.log('Updating');
			this.makeVersion();
			this.metadata.set('prev-state', JSON.stringify(this.safe()));
			const newData: any = { ...this.data, ...data };

			// Remove global columns
			delete newData.id;
			delete newData.created;
			delete newData.updated;
			delete newData.archived;
			// delete newData.universes;
			delete newData.universe;
			delete newData.attributes;
			delete newData.lifetime;
			await this.database
				.update(this.struct.table)
				.set({
					...newData,
					updated: now
				})
				.where(sql`${this.struct.table.id} = ${this.id}`);

			if (config.emit === false) this.metadata.set('no-emit', true);
			if (config.source) this.metadata.set('source', config.source);
			Object.assign(this.data, {
				...newData,
				updated: now
			});
			this.struct.emit('update', {
				from: prev,
				to: this
			});
		});
	}

	/**
	 * Sets the data to be archived or restored, this will emit an archive or restore event respectively
	 *
	 * @param {boolean} archived
	 * @param {?{
	 *         emit?: boolean;
	 *     }} [config]
	 * @returns {*}
	 */
	setArchive(
		archived: boolean,
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
				if (archived) {
					return this.struct.data.proxyClient.archive(this.struct, this.id).unwrap();
				} else {
					return this.struct.data.proxyClient.restore(this.struct, this.id).unwrap();
				}
			}
			this.log('Setting archive:', archived);
			await this.struct.database
				.update(this.struct.table)
				.set({
					archived,
					updated: new Date()
				} as any)
				.where(sql`${this.struct.table.id} = ${this.id}`);
			Object.assign(this.data, {
				archived
			});

			if (config.emit === false) this.metadata.set('no-emit', true);
			if (config.source) this.metadata.set('source', config.source);
			this.struct.emit(archived ? 'archive' : 'restore', this);
		});
	}

	/**
	 * Deletes the data, this will emit a delete event
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
			if (this.struct.data.proxyClient) {
				return this.struct.data.proxyClient.delete(this.struct, this.id).unwrap();
			}
			this.log('Deleting');
			this.makeVersion();
			await this.database
				.delete(this.struct.table)
				.where(sql`${this.struct.table.id} = ${this.id}`);
			if (config.emit === false) this.metadata.set('no-emit', true);
			if (config.source) this.metadata.set('source', config.source);
			this.struct.emit('delete', this);
		});
	}

	/**
	 * Makes a version of the data, this will emit a create event.
	 * This shouldn't be used outside of this class, it's only public for testing purposes.
	 *
	 * @returns {*}
	 */
	makeVersion() {
		return attemptAsync(async () => {
			if (this.struct.data.proxyClient) {
				return this.struct.data.proxyClient.makeVersion(this.struct, this.id).unwrap();
			}

			if (isTesting(this.struct)) {
				const table = TestTable.get(this.struct.data.name);
				if (!table) throw noTableError(this.struct);
				const data = table.fromId(this.id).unwrap();
				if (!data) throw noDataError(this);
				return new DataVersion(this.struct, data.makeVersion().unwrap().data as any);
			}

			if (!this.struct.versionTable)
				throw new Error(
					`Struct ${this.struct.name} does not have a version table`
				);
			this.log('Making version');
			const vhId = uuid();
			const vhCreated = new Date().toISOString();
			const vhData = { ...this.data, vhId, vhCreated } as any;
			await this.database.insert(this.struct.versionTable).values(vhData);

			const prev = (await this.getVersions()).unwrap();
			if (this.struct.data.versionHistory) {
				if (this.struct.data.versionHistory.type === 'days') {
					const days = this.struct.data.versionHistory.amount;
					const date = new Date();
					date.setDate(date.getDate() - days);
					const toDelete = prev.filter((v) => v.vhCreated < date);
					for (const v of toDelete) {
						await v.delete();
					}
				} else if (this.struct.data.versionHistory.type === 'versions') {
					const amount = this.struct.data.versionHistory.amount;
					const toDelete = prev.slice(0, prev.length - amount);
					for (const v of toDelete) {
						await v.delete();
					}
				}
			}

			return new DataVersion(this.struct, vhData);
		});
	}

	/**
	 * Gets all versions of the data as an array.
	 * This isn't a stream because there likely aren't going to be a lot of versions.
	 * This may change in the future.
	 *
	 * @returns {*}
	 */
	getVersions() {
		return attemptAsync(async () => {
			if (this.struct.data.proxyClient) {
				return this.struct.data.proxyClient.getVersions(this.struct, this.id).unwrap();
			}
			if (isTesting(this.struct)) {
				const table = TestTable.get(this.struct.name);
				if (!table) throw noTableError(this.struct);
				const data = table.fromId(this.data.id).unwrap();
				if (!data) throw noDataError(this);
				return data.getVersions().unwrap().map(v => new DataVersion(this.struct, v.data));
			}
			if (!this.struct.versionTable)
				throw new StructError(
					this.struct,
					`Struct ${this.struct.name} does not have a version table`
				);
			const data = await this.database
				.select()
				.from(this.struct.versionTable)
				.where(sql`${this.struct.versionTable.id} = ${this.id}`);
			return data.map((d) => new DataVersion(this.struct, d as any));
		});
	}

	// TODO: events for attributes and universes
	/**
	 * Returns an array of attributes
	 *
	 * @returns {*}
	 */
	getAttributes() {
		return attempt(() => {
			if (isTesting(this.struct)) {
				const table = TestTable.get(this.struct.name);
				if (!table) throw noTableError(this.struct);
				const data = table.fromId(this.data.id).unwrap();
				if (!data) throw noDataError(this);
				return data.getAttributes().unwrap();
			}
			const a = JSON.parse(this.data.attributes);
			if (!Array.isArray(a)) throw new DataError(this.struct, 'Attributes must be an array');
			if (!a.every((i) => typeof i === 'string'))
				throw new DataError(this.struct, 'Attributes must be an array of strings');
			return a;
		});
	}
	/**
	 * Sets the attributes
	 *
	 * @param {string[]} attributes
	 * @returns {*}
	 */
	setAttributes(attributes: string[]) {
		return attemptAsync(async () => {
			if (isTesting(this.struct)) {
				const table = TestTable.get(this.struct.name);
				if (!table) throw noTableError(this.struct);
				const data = table.fromId(this.data.id).unwrap();
				if (!data) throw noDataError(this);
				return data.setAttributes(...attributes).unwrap();
			}
			const prev = { ...this.data };
			this.log('Setting attributes', attributes);
			attributes = attributes
				.filter((i) => typeof i === 'string')
				.filter((v, i, a) => a.indexOf(v) === i);
			const updated = new Date();
			await this.database
				.update(this.struct.table)
				.set({
					attributes: JSON.stringify(attributes),
					updated
				} as any)
				.where(sql`${this.struct.table.id} = ${this.id}`);
			Object.assign(this.data, {
				attributes,
				updated
			});
			this.struct.emit('update', {
				from: prev,
				to: this
			});
		});
	}
	/**
	 * Removes attributes
	 *
	 * @param {...string[]} attributes
	 * @returns {*}
	 */
	removeAttributes(...attributes: string[]) {
		return attemptAsync(async () => {
			if (isTesting(this.struct)) {
				const table = TestTable.get(this.struct.name);
				if (!table) throw noTableError(this.struct);
				const data = table.fromId(this.data.id).unwrap();
				if (!data) throw noDataError(this);
				return data.removeAttributes(...attributes).unwrap();
			}
			const a = this.getAttributes().unwrap();
			const newAttributes = a.filter((i) => !attributes.includes(i));
			return (await this.setAttributes(newAttributes)).unwrap();
		});
	}
	/**
	 * Adds attributes
	 *
	 * @param {...string[]} attributes
	 * @returns {*}
	 */
	addAttributes(...attributes: string[]) {
		return attemptAsync(async () => {
			if (isTesting(this.struct)) {
				const table = TestTable.get(this.struct.name);
				if (!table) throw noTableError(this.struct);
				const data = table.fromId(this.data.id).unwrap();
				if (!data) throw noDataError(this);
				return data.addAttributes(...attributes).unwrap();
			}
			const a = this.getAttributes().unwrap();
			return (await this.setAttributes([...a, ...attributes])).unwrap();
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
	 * @memberof StructData
	 * @example
	 * const data = struct.fromId('id').unwrap();
	 * const safeData = data.safe('id', 'created'); // This will return the data without the id and created columns
	 */
	safe<Keys extends (keyof (T & typeof globalCols))[]>(
		...omit: Keys
	): SafeReturn<T, Keys> {
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


	/**
	 * If this data is similar to another data
	 *
	 * @param {Structable<T>} data
	 * @returns {boolean}
	 */
	isSimilar(data: Structable<T>) {
		for (const key in data) {
			if (data[key] !== this.data[key]) return false;
		}
		return true;
	}

	/**
	 * This is to handle states diverging between frontend and backend, or between servers
	 */
	emitSelf() {
		this.struct.emit('update', {
			from: this.data,
			to: this
		});
	}

	/**
	 * Logs an event to the console, this is used for debugging and development purposes.
	 *
	 * @param {...unknown[]} data 
	 */
	log(...data: unknown[]) {
		this.struct.log(chalk.magenta(`(${this.id})`), ...data);
	}

	/**
	 * Sets the data to be static or not, this will emit an update event.
	 *
	 * @param {boolean} isStatic 
	 * @returns {*} 
	 */
	setStatic(isStatic: boolean) {
		return attemptAsync(async () => {
			this.log('Setting static:', isStatic);
			await this.database
				.update(this.struct.table)
				.set({
					canUpdate: !isStatic,
					updated: new Date()
				} as any)
				.where(sql`${this.struct.table.id} = ${this.id}`);
			Object.assign(this.data, {
				canUpdate: true
			});
			this.emitSelf();
		});
	}
}

/**
 * Converts a struct data to JSON.
 * Dates are turned into ISO strings.
 *
 * @template {Blank} T
 * @param {Struct<T, string>} struct
 * @param {Structable<T & typeof globalCols>} data
 * @returns {*}
 */
export const toJson = <T extends Blank>(
	struct: Struct<T, string>,
	data: Structable<T & typeof globalCols>
) => {
	return attempt<Structable<T>>(() => {
		const obj: any = {};

		for (const key in data) {
			// drizzle's type during compile and runtime are different, '_' at compile is 'config' at runtime
			const type = (struct.data.structure[key] as any).config.dataType as ColumnDataType;
			const d = data[key];
			switch (type) {
				case 'string':
				case 'number':
				case 'boolean':
					obj[key] = d;
					break;
				case 'date':
					if (d instanceof Date) {
						obj[key] = d.toISOString();
					}
					break;
				default:
					throw new DataError(struct, `Invalid data type: ${type} in ${key} of ${struct.name}`);
			}
		}

		return obj;
	});
};

/**
 * All events that can be emitted by a struct and the data they emit
 *
 * @export
 * @typedef {StructEvents}
 * @template {Blank} T
 * @template {string} Name
 */
export type StructEvents<T extends Blank, Name extends string> = {
	update: [{
		from: Structable<T & typeof globalCols>;
		to: StructData<T, Name>;
	}];
	archive: [StructData<T, Name>];
	delete: [StructData<T, Name>];
	restore: [StructData<T, Name>];
	create: [StructData<T, Name>];
	'delete-version': [DataVersion<T, Name>];
	'restore-version': [DataVersion<T, Name>];

	build: void;
	error: [StructError];
	'fatal-error': [FatalStructError];
	'data-error': [DataError];
	'fatal-data-error': [FatalDataError];

	connect: void;
};

/**
 * Request event for sveltekit requests
 *
 * @export
 * @interface RequestEvent
 * @typedef {RequestEvent}
 */
export interface RequestEvent {
	/**
	 * The request object
	 *
	 * @type {Request}
	 */
	request: Request;
	/**
	 * Yes, this is an any, but it's a placeholder for now
	 *
	 * @type {*}
	 */
	cookies: any;

	/**
	 * various parameters from the request
	 *
	 * @type {{
	 * 		session: Session;
	 * 		account?: Account;
	 * 	}}
	 */
	locals: {
		session: Session;
		account?: Account;
	}
}

/**
 * Request action for sveltekit struct requests
 *
 * @export
 * @typedef {RequestAction}
 */
export type RequestAction = {
	action: DataAction | PropertyAction | string;
	data: unknown;
	request: RequestEvent;
	struct: Struct;
};

/**
 * Converts postgres datatypes to typescript types
 *
 * @export
 * @typedef {TsType}
 * @template {ColumnDataType} T
 */
export type TsType<T extends ColumnDataType> = T extends 'string'
	? string
	: T extends 'number'
		? number
		: T extends 'boolean'
			? boolean
				: T extends 'date' ? Date
				: never;

type ISOString = `${number}-${number}-${number}T${number}:${number}:${number}.${number}Z`;

export type SafeTsType<T extends ColumnDataType> = T extends 'string'
	? string
	: T extends 'number'
		? number
		: T extends 'boolean'
			? boolean
				: T extends 'date' ? ISOString
				: never;

// export type SafeTsType<T extends ColumnDataType> = T extends 'string' ? string
//     : T extends 'number' ? number
//     : T extends 'boolean' ? boolean
//     : T extends 'timestamp' ? string
//     : T extends 'date' ? string
//     : never;

/**
 * MultiConfig is used to configure how you want to retrieve data from a struct.
 *
 * @export
 * @typedef {MultiConfig}
 */
export type MultiConfig = {
	type: 'stream',
	includeArchived?: boolean;
} | {
	type: 'array',
	includeArchived?: boolean;
	limit: number;
	offset: number;
} | {
	type: 'single',
	includeArchived?: boolean;
} | {
	type: 'count',
	includeArchived?: boolean;
} | {
	type: 'all',
	includeArchived?: boolean;
}

/**
 * Struct class, this is the main class for creating and managing structs.
 *
 * @export
 * @class Struct
 * @typedef {Struct}
 * @template {Blank} [T=any]
 * @template {string} [Name=any]
 */
export class Struct<T extends Blank = any, Name extends string = any> {
	/**
	 * If the struct is should run logs
	 *
	 * @private
	 * @static
	 * @type {boolean}
	 */
	private static loggingSet = false;

	/**
	 * Set directory for event logging
	 */
	public static async setupLogger(
		logDir: string,
		fn?: (log: {
			struct: string;
			event: string;
			type: 'info' | 'warn' | 'error';
			message: string;
			timestamp: string;
		}) => unknown
	) {
		if (Struct.loggingSet) throw new Error('Logging already set up');

		try {
			await fs.promises.mkdir(logDir, { recursive: true });
		} catch {
			// do nothing
		}

		Struct.each((s) => {
			const file = path.join(logDir, `${s.name}.log`);

			const l = (data: { event: string; type: 'info' | 'warn' | 'error'; message: string }) => {
				log(file, data);
				fn?.({
					struct: s.name,
					timestamp: new Date().toISOString(),
					...data
				});
			};

			s.on('archive', (d) =>
				l({
					type: 'info',
					event: 'archive',
					message: `Archived ${d.id}`
				})
			);

			s.on('create', (d) =>
				l({
					type: 'info',
					event: 'create',
					message: `Created ${d.id}`
				})
			);

			s.on('delete', (d) =>
				l({
					type: 'info',
					event: 'delete',
					message: `Deleted ${d.id}`
				})
			);

			s.on('restore', (d) =>
				l({
					type: 'info',
					event: 'restore',
					message: `Restored ${d.id}`
				})
			);

			s.on('update', (d) =>
				l({
					type: 'info',
					event: 'update',
					message: `Updated ${d.to.id}`
				})
			);

			s.on('delete-version', (d) =>
				l({
					type: 'info',
					event: 'delete-version',
					message: `Deleted version ${d.vhId}`
				})
			);

			s.on('restore-version', (d) =>
				l({
					type: 'info',
					event: 'restore-version',
					message: `Restored version ${d.vhId}`
				})
			);

			s.on('build', () =>
				l({
					type: 'info',
					event: 'build',
					message: 'Built'
				})
			);

			s.on('error', (e) =>
				l({
					type: 'warn',
					event: 'error',
					message: e.message
				})
			);

			s.on('fatal-error', (e) =>
				l({
					type: 'error',
					event: 'fatal-error',
					message: e.message
				})
			);

			s.on('data-error', (e) =>
				l({
					type: 'warn',
					event: 'data-error',
					message: e.message
				})
			);

			s.on('fatal-data-error', (e) =>
				l({
					type: 'error',
					event: 'fatal-data-error',
					message: e.message
				})
			);
		});
	}

	/**
	 * Build all structs that the program has access to
	 *
	 * @public
	 * @static
	 * @async
	 * @param {PostgresJsDatabase} database
	 * @param {?(event: RequestAction) => Promise<Response> | Response} [handler]
	 * @returns {any) => unknown}
	 */
	public static buildAll(
		database: PostgresJsDatabase,
		// handler?: (event: RequestAction) => Promise<Response> | Response
	) {
		return attemptAsync(async () => {
			return resolveAll(
				await Promise.all([...Struct.structs.values()].map((s) => s.build(database, /*handler*/)))
			).unwrap();
		});
	}

	/**
	 * Map of all structs the program has access to
	 *
	 * @public
	 * @static
	 * @readonly
	 * @type {*}
	 */
	public static readonly structs = new Map<string, Struct<Blank, string>>();

	/**
	 * Lifetime loop for all structs, if the data has a lifetime, it will delete it after the lifetime has passed
	 *
	 * @public
	 * @static
	 * @param {number} time
	 * @returns {*}
	 */
	public static generateLifetimeLoop(time: number) {
		return new Loop(async () => {
			Struct.each(async (s) => {
				s.getLifetimeItems({
					type: 'stream'
				}).pipe(async (d) => {
					if (d.lifetime === 0) return;
					if (d.created.getTime() + d.lifetime < Date.now()) {
						(await d.delete()).unwrap();
					}
				});
			});
		}, time);
	}

	/**
	 * loops through all structs and runs a function
	 *
	 * @public
	 * @static
	 * @param {(struct: Struct<Blank, string>) => void} fn
	 * @returns {void) => void}
	 */
	public static each(fn: (struct: Struct<Blank, string>) => void) {
		for (const s of Struct.structs.values()) {
			fn(s);
		}
	}

	/**
	 * The postgres table for this struct
	 *
	 * @public
	 * @readonly
	 * @type {Table<T & typeof globalCols, Name>}
	 */
	public readonly table: Table<T & typeof globalCols, Name>;
	/**
	 * If this struct has a version history, this is the postgres table for the version history
	 *
	 * @public
	 * @readonly
	 * @type {?Table<T & typeof globalCols & typeof versionGlobalCols, `${Name}_history`>}
	 */
	public readonly versionTable?: Table<
		T & typeof globalCols & typeof versionGlobalCols,
		`${Name}_history`
	>;
	/**
	 * Event emitter for this struct
	 *
	 * @public
	 * @readonly
	 * @type {*}
	 */
	private readonly emitter = new ComplexEventEmitter<StructEvents<T, Name>>();

	/**
	 * Listens to an event
	 *
	 * @public
	 * @readonly
	 * @type {*}
	 */
	public readonly on = this.emitter.on.bind(this.emitter);
	/**
	 * Listens to an event once
	 *
	 * @public
	 * @readonly
	 * @type {*}
	 */
	public readonly once = this.emitter.once.bind(this.emitter);
	/**
	 * Removes an event listener
	 *
	 * @public
	 * @readonly
	 * @type {*}
	 */
	public readonly off = this.emitter.off.bind(this.emitter);
	/**
	 * Emits an event
	 *
	 * @public
	 * @readonly
	 * @type {*}
	 */
	public readonly emit = this.emitter.emit.bind(this.emitter);

	/**
	 * If a loop argument is passed, it will be set into this property.
	 *
	 * @public
	 * @type {?Loop}
	 */
	public loop?: Loop;
	/**
	 * Whether the struct has been built. No data can be set until it is.
	 *
	 * @public
	 * @type {boolean}
	 */
	public built = false;

	/**
	 * Creates an instance of Struct.
	 *
	 * @constructor
	 * @param {StructBuilder<T, Name>} data
	 */
	constructor(public readonly data: StructBuilder<T, Name>) {
		for (const key of Object.keys(data.structure)) {
			if (Object.keys(globalCols).includes(key)) {
				throw new FatalStructError(this, `Cannot have a custom column named ${key}`);
			}
		}

		Struct.structs.set(data.name, this as Struct);

		this.table = pgTable(data.name, {
			...globalCols,
			...data.structure
		});

		if (data.versionHistory) {
			this.log('Applying version table');
			this.versionTable = pgTable(`${data.name}_history`, {
				...globalCols,
				...versionGlobalCols,
				...data.structure
			});
		}

		if (this.data.proxyServer) {
			this.log('Setting up proxy server');
			this.data.proxyServer.setup(this as any);
		}

		if (this.data.proxyClient) {
			this.log('Setting up proxy client');
			this.data.proxyClient.setup(this as any);
		}
	}

	/**
	 * A reference to the database this struct's table is stored in.
	 * Because of how drizzle-orm works, it is not set until the struct is built.
	 *
	 * @private
	 * @type {?PostgresJsDatabase}
	 */
	private _database?: PostgresJsDatabase;

	/**
	 * A reference to the database this struct's table is stored in
	 *
	 * @readonly
	 * @type {PostgresJsDatabase}
	 */
	get database(): PostgresJsDatabase {
		if (!this._database) throw new FatalStructError(this, `${this.name} Struct database not set`);
		return this._database;
	}

	/**
	 * Name of the struct
	 *
	 * @readonly
	 * @type {Name}
	 */
	get name() {
		return this.data.name;
	}

	/**
	 * Generates a sample type of the data the struct will output. This is only used for testing and if it is called at runtime, it will throw an error.
	 *
	 * @readonly
	 * @type {StructData<T, Name>}
	 */
	get sample(): StructData<T, Name> {
		throw new Error('Struct.sample should never be called at runtime, it is only used for testing');
	}

	/**
	 * Whether the struct is frontend or not. If it is not set, it defaults to true.
	 *
	 * @readonly
	 * @type {boolean}
	 */
	get frontend() {
		return this.data.frontend === undefined ? true : this.data.frontend;
	}

	/**
	 * Creates a new struct data
	 *
	 * @param {Structable<T>} data
	 * @param {?{
	 *         emit?: boolean;
	 *         ignoreGlobals?: boolean;
	 *     }} [config]
	 * @returns {*}
	 */
	new(
		data: Structable<T> & Partial<Structable<typeof globalCols>>,
		config: {
			emit?: boolean;
			overwriteGlobals?: boolean;
			source?: string;
			static?: boolean;
			overwriteGenerators?: boolean;
		} = {
			emit: true,
			overwriteGlobals: false,
			source: 'self'
		}
	) {
		return attemptAsync(async () => {
			if (this.data.proxyClient) {
				return this.data.proxyClient.new(this, data).unwrap().then(d => this.Generator(d as any));
			}
			this.log('Creating new', data, config);
			const validateRes = this.validate(data, {
				optionals: config?.overwriteGlobals ? [] : (Object.keys(globalCols) as string[])
			});

			if (!validateRes.success) {
				throw new DataError(
					this,
					`Invalid Data Received, please check your data: ${validateRes.reason}`
				);
			}

			const globals = {
				id: this.data.generators?.id?.(data) ?? uuid(),
				created: new Date(),
				updated: new Date(),
				archived: false,
				// universes: JSON.stringify(this.data.generators?.universes?.() ?? []),
				// universe: this.data.generators?.universe?.(data) ?? '',
				attributes: JSON.stringify(this.data.generators?.attributes?.(data) ?? []),
				lifetime: this.data.lifetime || 0,
				canUpdate: !config.static
			};
			// I do overwriteglobals twice, because the input is a partial for globals.
			const newData: Structable<T & typeof globalCols> = {
				...(config?.overwriteGlobals ? globals : {}),
				...data,
				...(config?.overwriteGenerators
					? {}
					: (Object.fromEntries(
							Object.entries(this.data.generators || {})
								// Only do generators that are not global cols, those have already been set at this point
								.filter(([k]) => !Object.keys(globalCols).includes(k))
								.map(([k, v]) => [k, v(data)])
						) as any)),
				...(!config?.overwriteGlobals ? globals : {})
			};

			if (isTesting(this)) {
				const table = TestTable.get(this.data.name);
				if (!table) throw noTableError(this);
				return this.Generator(table.new(newData).unwrap().data);
			}

			await this.database.insert(this.table).values(newData as any);

			const d = this.Generator(newData);
			if (config.emit === false) d.metadata.set('no-emit', true);
			if (config.source) d.metadata.set('source', config.source);
			this.emitter.emit('create', this.Generator(newData));

			return d;
		});
	}

	/**
	 * Generator for the struct data. This is used to create a new instance of StructData easily.
	 *
	 * @param {Structable<T & typeof globalCols>} data
	 * @returns {StructData<T, Name>}
	 */
	Generator(data: Structable<T & typeof globalCols>) {
		const res = this.validate(data);
		if (!res.success)
			console.warn(
				'Invalid data, there may be issues. If you see this, please fix your program, as this will become an error in the future',
				data,
				res.reason
			);
		return new StructData(data, this);
	}

	/**
	 * Pulls a single StructData from the database by id
	 *
	 * @param {string} id
	 * @returns {*}
	 */
	fromId(id: string) {
		return attemptAsync(async () => {
			if (isTesting(this)) {
				const table = TestTable.get(this.data.name);
				if (!table) throw noTableError(this);
				const res = table.fromId(id).unwrap();
				if (res) return this.Generator(res.data);
				return undefined;
			}
			const data = await this.database
				.select()
				.from(this.table)
				.where(sql`${this.table.id} = ${id}`);
			const a = data[0];
			if (!a) {
				return;
			}
			return this.Generator(a as any);
		});
	}

	/**
	 * Retrieves a StructData from the struct based on the vhId.
	 * This is used to retrieve a specific version of the data.
	 * Useful for if a data is deleted and you want to restore it.
	 * @param vhId The version history ID to retrieve the data from.
	 * @throws {FatalStructError} If the struct does not have a version table.
	 * @returns {ResultPromise<DataVersion<T, Name> | undefined>} The data version or undefined if not found.
	 * @memberof StructData
	 * @example
	 * const version = await struct.fromVhId('some-vh-id').unwrap();
	 * if (version) {
	 *   console.log('Retrieved version:', version);
	 * } else {
	 *  console.log('Version not found');
	 * }
	 */
	fromVhId(vhId: string) {
		return attemptAsync(async () => {
			if (isTesting(this)) {
				const table = TestTable.get(this.data.name);
				if (!table) throw noTableError(this);
				const v = table.fromVhId(vhId).unwrap();
				if (!v) {
					throw new Error(`No version found with vhId ${vhId} in ${this.data.name} testing suite`)
				}
				return new DataVersion(this, v.data);
			}
			
			if (!this.versionTable) {
				throw new FatalStructError(
					this,
					`Struct ${this.name} does not have a version table`
				);
			}

			const [data] = await this.database
				.select()
				.from(this.versionTable)
				.where(sql`${this.versionTable.vhId} = ${vhId}`);
			if (!data) return undefined;
			return new DataVersion(this, data as any);
		});
	}

	/**
	 * Retrieves all data from the struct based on the config provided.
	 *
	 * @param {{ type: 'stream'; limit?: number; offset?: number }} config 
	 * @returns {StructStream<T, Name>} 
	 */
	all(config: { type: 'stream'; limit?: number; offset?: number }): StructStream<T, Name>;
	/**
	 * 	Retrieves all data from the struct based on the config provided.
	 *
	 * @param {{
	 * 		type: 'array';
	 * 		limit: number;
	 * 		offset: number;
	 * 		includeArchived?: boolean;
	 * 	}} config 
	 * @returns {ResultPromise<StructData<T, Name>[], Error>} 
	 */
	all(config: {
		type: 'array';
		limit: number;
		offset: number;
		includeArchived?: boolean;
	}): ResultPromise<StructData<T, Name>[], Error>;
	/**
	 * Retrieves all data from the struct based on the config provided.
	 *
	 * @param {{ type: 'single'; includeArchived?: boolean; }} config 
	 * @returns {(ResultPromise<StructData<T, Name> | undefined, Error>)} 
	 */
	all(config: { type: 'single'; includeArchived?: boolean; }): ResultPromise<StructData<T, Name> | undefined, Error>;
	/**
	 * Retrieves all data from the struct based on the config provided.
	 *
	 * @param {{ type: 'count'; includeArchived?: boolean; }} config 
	 * @returns {ResultPromise<number>} 
	 */
	all(config: { type: 'count'; includeArchived?: boolean; }): ResultPromise<number>;
	/**
	 * Retrieves all data from the struct based on the config provided.
	 *
	 * @param {{ type: 'all'; includeArchived?: boolean; }} config 
	 * @returns {ResultPromise<StructData<T, Name>[], Error>} 
	 */
	all(config: { type: 'all'; includeArchived?: boolean; }): ResultPromise<StructData<T, Name>[], Error>;
	/**
	 * Retrieves all data from the struct based on the config provided.
	 *
	 * @param {MultiConfig} config 
	 * @returns {(| StructStream<T, Name>
	 * 		| ResultPromise<StructData<T, Name>[] | undefined | StructData<T, Name> | number, Error>)} 
	 */
	all(
		config: MultiConfig
	):
		| StructStream<T, Name>
		| ResultPromise<StructData<T, Name>[] | undefined | StructData<T, Name> | number, Error> {
		const get = async () => {
			if (isTesting(this)) {
				const table = TestTable.get(this.data.name);
				if (!table) throw noTableError(this);
				return table.all().unwrap().map(d => d.data);
			}

			const squeal = config.includeArchived ? sql`1 = 1` : sql`${this.table.archived} = ${false}`;

			if (config.type === 'count') {
				const res = await this.database
					.select({
						count: count()
					})
					.from(this.table)
					.where(squeal);
				return res[0].count;
			}

			if (config.type === 'single') {
				return (await this.database.select().from(this.table).where(squeal).orderBy(this.table.created))[0];
			}

			const { offset, limit } = {
				offset: undefined,
				limit: undefined,
				...config,
			};
			if (offset !== undefined && limit !== undefined) {
				return this.database.select().from(this.table).where(squeal).orderBy(this.table.created).offset(offset).limit(limit);
			} else {
				return this.database.select().from(this.table).where(squeal).orderBy(this.table.created);
			}
		};

		if (config.type === 'stream') {
			const stream = new StructStream(this);
			setTimeout(async () => {
				const dataStream = (await get()) as Structable<T & typeof globalCols>[];
				for (let i = 0; i < dataStream.length; i++) {
					stream.add(this.Generator(dataStream[i] as any));
				}
				stream.end();
			});
			return stream;
		} else {
			return attemptAsync(async () => {
				const data = (await get()) as
					| Structable<T & typeof globalCols>[]
					| Structable<T & typeof globalCols>
					| number;
				if (Array.isArray(data)) {
					return data.map((d) => this.Generator(d));
				} else if (typeof data === 'object') {
					return this.Generator(data);
				} else {
					return data;
				}
			});
		}
	}

	/**
	 * Retrieves archived data from the struct based on the config provided.
	 *
	 * @param {{ type: 'stream'; limit?: number; offset?: number }} config 
	 * @returns {StructStream<T, Name>} 
	 */
	archived(config: { type: 'stream'; limit?: number; offset?: number }): StructStream<T, Name>;
	/**
	 *	 Retrieves archived data from the struct based on the config provided.
	 *
	 * @param {{
	 * 		type: 'array';
	 * 		limit: number;
	 * 		offset: number;
	 * 	}} config 
	 * @returns {ResultPromise<StructData<T, Name>[], Error>} 
	 */
	archived(config: {
		type: 'array';
		limit: number;
		offset: number;
	}): ResultPromise<StructData<T, Name>[], Error>;
	/**
	 * Retrieves archived data from the struct based on the config provided.
	 *
	 * @param {{ type: 'single' }} config 
	 * @returns {(ResultPromise<StructData<T, Name> | undefined, Error>)} 
	 */
	archived(config: { type: 'single' }): ResultPromise<StructData<T, Name> | undefined, Error>;
	/**
	 * Retrieves archived data from the struct based on the config provided.
	 *
	 * @param {{ type: 'count' }} config 
	 * @returns {ResultPromise<number>} 
	 */
	archived(config: { type: 'count' }): ResultPromise<number>;
	/**
	 * Retrieves archived data from the struct based on the config provided.
	 *
	 * @param {{ type: 'all' }} config 
	 * @returns {ResultPromise<StructData<T, Name>[], Error>} 
	 */
	archived(config: { type: 'all' }): ResultPromise<StructData<T, Name>[], Error>;
	/**
	 * Retrieves archived data from the struct based on the config provided.
	 *
	 * @param {{
	 * 		type: 'stream' | 'array' | 'single' | 'count' | 'all';
	 * 		limit?: number;
	 * 		offset?: number;
	 * 	}} config 
	 * @returns {(| StructStream<T, Name>
	 * 		| ResultPromise<StructData<T, Name>[] | StructData<T, Name> | undefined | number, Error>)} 
	 */
	archived(config: {
		type: 'stream' | 'array' | 'single' | 'count' | 'all';
		limit?: number;
		offset?: number;
	}):
		| StructStream<T, Name>
		| ResultPromise<StructData<T, Name>[] | StructData<T, Name> | undefined | number, Error> {
		const get = async () => {
			if (isTesting(this)) {
				const table = TestTable.get(this.data.name);
				if (!table) throw noTableError(this);
				return table.archived().unwrap().map(d => d.data);
			}

			const squeal = sql`${this.table.archived} = ${true}`;

			if (config.type === 'count') {
				const res = await this.database
					.select({
						count: count()
					})
					.from(this.table)
					.where(squeal);
				return res[0].count;
			}

			if (config.type === 'single') {
				return (await this.database.select().from(this.table).where(squeal).orderBy(this.table.created))[0];
			}

			const { offset, limit } = config;
			if (offset && limit) {
				return this.database.select().from(this.table).where(squeal).orderBy(this.table.created).offset(offset).limit(limit);
			} else {
				return this.database.select().from(this.table).where(squeal).orderBy(this.table.created);
			}
		};

		if (config.type === 'stream') {
			const stream = new StructStream(this);
			setTimeout(async () => {
				const dataStream = (await get()) as Structable<T & typeof globalCols>[];
				for (let i = 0; i < dataStream.length; i++) {
					stream.add(this.Generator(dataStream[i] as any));
				}
				stream.end();
			});
			return stream;
		} else {
			return attemptAsync(async () => {
				const data = (await get()) as
					| Structable<T & typeof globalCols>[]
					| Structable<T & typeof globalCols>
					| number;
				if (Array.isArray(data)) {
					return data.map((d) => this.Generator(d));
				} else if (typeof data === 'object') {
					return this.Generator(data);
				} else {
					return data;
				}
			});
		}
	}

	/**
	 * Retrieves data from the struct based on a property and value.
	 *
	 * @template {keyof (T & typeof globalCols)} K 
	 * @param {K} property 
	 * @param {TsType<(T & typeof globalCols)[K]['_']['dataType']>} value 
	 * @param {{
	 * 			type: 'stream';
	 * 			limit?: number;
	 * 			offset?: number;
	 * 			includeArchived?: boolean;
	 * 		}} config 
	 * @returns {StructStream<T, Name>} 
	 */
	fromProperty<K extends keyof (T & typeof globalCols)>(
		property: K,
		value: TsType<(T & typeof globalCols)[K]['_']['dataType']>,
		config: {
			type: 'stream';
			limit?: number;
			offset?: number;
			includeArchived?: boolean;
		}
	): StructStream<T, Name>;
	/**
	 * Retrieves data from the struct based on a property and value.
	 *
	 * @template {keyof (T & typeof globalCols)} K 
	 * @param {K} property 
	 * @param {TsType<(T & typeof globalCols)[K]['_']['dataType']>} value 
	 * @param {{
	 * 			type: 'array';
	 * 			limit: number;
	 * 			offset: number;
	 * 			includeArchived?: boolean;
	 * 		}} config 
	 * @returns {ResultPromise<StructData<T, Name>[], Error>} 
	 */
	fromProperty<K extends keyof (T & typeof globalCols)>(
		property: K,
		value: TsType<(T & typeof globalCols)[K]['_']['dataType']>,
		config: {
			type: 'array';
			limit: number;
			offset: number;
			includeArchived?: boolean;
		}
	): ResultPromise<StructData<T, Name>[], Error>;
	/**
	 * Retrieves data from the struct based on a property and value.
	 *
	 * @template {keyof (T & typeof globalCols)} K 
	 * @param {K} property 
	 * @param {TsType<(T & typeof globalCols)[K]['_']['dataType']>} value 
	 * @param {{
	 * 			type: 'single';
	 * 			includeArchived?: boolean;
	 * 		}} config 
	 * @returns {(ResultPromise<StructData<T, Name> | undefined, Error>)} 
	 */
	fromProperty<K extends keyof (T & typeof globalCols)>(
		property: K,
		value: TsType<(T & typeof globalCols)[K]['_']['dataType']>,
		config: {
			type: 'single';
			includeArchived?: boolean;
		}
	): ResultPromise<StructData<T, Name> | undefined, Error>;
	/**
	 * Retrieves data from the struct based on a property and value.
	 *
	 * @template {keyof (T & typeof globalCols)} K 
	 * @param {K} property 
	 * @param {TsType<(T & typeof globalCols)[K]['_']['dataType']>} value 
	 * @param {{
	 * 			type: 'count';
	 * 			includeArchived?: boolean;
	 * 		}} config 
	 * @returns {ResultPromise<number>} 
	 */
	fromProperty<K extends keyof (T & typeof globalCols)>(
		property: K,
		value: TsType<(T & typeof globalCols)[K]['_']['dataType']>,
		config: {
			type: 'count';
			includeArchived?: boolean;
		}
	): ResultPromise<number>;
	/**
	 * Retrieves data from the struct based on a property and value.
	 *
	 * @template {keyof (T & typeof globalCols)} K 
	 * @param {K} property 
	 * @param {TsType<(T & typeof globalCols)[K]['_']['dataType']>} value 
	 * @param {{
	 * 			type: 'all';
	 * 			includeArchived?: boolean;
	 * 		}} config 
	 * @returns {ResultPromise<StructData<T, Name>[], Error>} 
	 */
	fromProperty<K extends keyof (T & typeof globalCols)>(
		property: K,
		value: TsType<(T & typeof globalCols)[K]['_']['dataType']>,
		config: {
			type: 'all';
			includeArchived?: boolean;
		}
	): ResultPromise<StructData<T, Name>[], Error>;
	/**
	 * Retrieves data from the struct based on a property and value.
	 *
	 * @template {keyof (T & typeof globalCols)} K 
	 * @param {K} property 
	 * @param {TsType<(T & typeof globalCols)[K]['_']['dataType']>} value 
	 * @param {MultiConfig} config 
	 * @returns {(| StructStream<T, Name>
	 * 		| ResultPromise<StructData<T, Name>[] | StructData<T, Name> | undefined | number, Error>)} 
	 */
	fromProperty<K extends keyof (T & typeof globalCols)>(
		property: K,
		value: TsType<(T & typeof globalCols)[K]['_']['dataType']>,
		config: MultiConfig
	):
		| StructStream<T, Name>
		| ResultPromise<StructData<T, Name>[] | StructData<T, Name> | undefined | number, Error> {
		const get = async () => {
			if (isTesting(this)) {
				const table = TestTable.get(this.data.name);
				if (!table) throw noTableError(this);
				return table.fromProperty(property, value).unwrap().map(d => d.data);
			}


			let squeal: SQL;
			if (config.includeArchived) {
				squeal = sql`${this.table[property]} = ${value}`;
			} else {
				squeal = sql`${this.table[property]} = ${value} AND ${this.table.archived} = ${false}`;
			}

			if (config.type === 'count') {
				const res = await this.database
					.select({
						count: count()
					})
					.from(this.table)
					.where(squeal);
				return res[0].count;
			}

			if (config.type === 'single') {
				return (await this.database.select().from(this.table).where(squeal).orderBy(this.table.created))[0];
			}

			const { offset, limit } = {
				offset: undefined,
				limit: undefined,
				...config,
			};
			if (offset && limit) {
				return this.database.select().from(this.table).where(squeal).orderBy(this.table.created).offset(offset).limit(limit);
			} else {
				return this.database.select().from(this.table).where(squeal).orderBy(this.table.created);
			}
		};

		if (config.type === 'stream') {
			const stream = new StructStream(this);
			setTimeout(async () => {
				const dataStream = (await get()) as Structable<T & typeof globalCols>[];
				for (let i = 0; i < dataStream.length; i++) {
					stream.add(this.Generator(dataStream[i] as any));
				}
				stream.end();
			});
			return stream;
		} else {
			return attemptAsync(async () => {
				const data = (await get()) as
					| Structable<T & typeof globalCols>[]
					| Structable<T & typeof globalCols>
					| number;
				if (Array.isArray(data)) {
					return data.map((d) => this.Generator(d));
				} else if (typeof data === 'object') {
					return this.Generator(data);
				} else {
					return data;
				}
			});
		}
	}

	/**
	 * Retrieves data from the struct based on the properties and values provided. (This method is unstable, use with caution)
	 *
	 * @param {{
	 * 			[K in keyof T]?: TsType<T[K]['_']['dataType']>;
	 * 		}} props 
	 * @param {{
	 * 			type: 'stream';
	 * 			limit?: number;
	 * 			offset?: number;
	 * 		}} config 
	 * @returns {StructStream<T, Name>} 
	 */
	get(
		props: {
			[K in keyof T]?: TsType<T[K]['_']['dataType']>;
		},
		config: {
			type: 'stream';
			limit?: number;
			offset?: number;
		}
	): StructStream<T, Name>;
	/**
	 * Retrieves data from the struct based on the properties and values provided. (This method is unstable, use with caution)
	 *
	 * @param {{
	 * 			[K in keyof T]?: TsType<T[K]['_']['dataType']>;
	 * 		}} props 
	 * @param {{
	 * 			type: 'array';
	 * 			limit: number;
	 * 			offset: number;
	 * 		}} config 
	 * @returns {ResultPromise<StructData<T, Name>[], Error>} 
	 */
	get(
		props: {
			[K in keyof T]?: TsType<T[K]['_']['dataType']>;
		},
		config: {
			type: 'array';
			limit: number;
			offset: number;
		}
	): ResultPromise<StructData<T, Name>[], Error>;
	/**
	 * Retrieves data from the struct based on the properties and values provided. (This method is unstable, use with caution)
	 *
	 * @param {{
	 * 			[K in keyof T]?: TsType<T[K]['_']['dataType']>;
	 * 		}} props 
	 * @param {{
	 * 			type: 'single';
	 * 		}} config 
	 * @returns {(ResultPromise<StructData<T, Name> | undefined, Error>)} 
	 */
	get(
		props: {
			[K in keyof T]?: TsType<T[K]['_']['dataType']>;
		},
		config: {
			type: 'single';
		}
	): ResultPromise<StructData<T, Name> | undefined, Error>;
	/**
	 * Retrieves data from the struct based on the properties and values provided. (This method is unstable, use with caution)
	 *
	 * @param {{
	 * 			[K in keyof T]?: TsType<T[K]['_']['dataType']>;
	 * 		}} props 
	 * @param {{
	 * 			type: 'count';
	 * 		}} config 
	 * @returns {ResultPromise<number>} 
	 */
	get(
		props: {
			[K in keyof T]?: TsType<T[K]['_']['dataType']>;
		},
		config: {
			type: 'count';
		}
	): ResultPromise<number>;
	/**
	 * Retrieves data from the struct based on the properties and values provided. (This method is unstable, use with caution)
	 *
	 * @param {{
	 * 			[K in keyof T]?: TsType<T[K]['_']['dataType']>;
	 * 		}} props 
	 * @param {{
	 * 			type: 'all';
	 * 		}} config 
	 * @returns {ResultPromise<StructData<T, Name>[], Error>} 
	 */
	get(
		props: {
			[K in keyof T]?: TsType<T[K]['_']['dataType']>;
		},
		config: {
			type: 'all';
		}
	): ResultPromise<StructData<T, Name>[], Error>;
	/**
	 * Retrieves data from the struct based on the properties and values provided. (This method is unstable, use with caution)
	 *
	 * @param {{
	 * 			[K in keyof T]?: TsType<T[K]['_']['dataType']>;
	 * 		}} props 
	 * @param {MultiConfig} config 
	 * @returns {(| StructStream<T, Name>
	 * 		| ResultPromise<StructData<T, Name>[] | StructData<T, Name> | undefined | number, Error>)} 
	 */
	get(
		props: {
			[K in keyof T]?: TsType<T[K]['_']['dataType']>;
		},
		config: MultiConfig
	):
		| StructStream<T, Name>
		| ResultPromise<StructData<T, Name>[] | StructData<T, Name> | undefined | number, Error> {
		console.warn(
			`Struct.get() This method is unstable, use with caution. fromProperty is recommended at this time`
		);
		const get = async () => {
			if (isTesting(this)) {
				const table = TestTable.get(this.data.name);
				if (!table) throw noTableError(this);
				return table.get(props).unwrap().map(d => d.data);
			}

			// const squeal = sql.join(Object.keys(props).map(k => sql`${this.table[k]} = ${props[k]}`), sql` AND `);
			let squeal = sql`1 = 1`;
			for (const key in props) {
				if (squeal) {
					squeal = sql`${squeal} AND ${this.table[key]} = ${props[key]}`;
				} else {
					squeal = sql`${this.table[key]} = ${props[key]}`;
				}
			}

			if (config.type === 'count') {
				const res = await this.database
					.select({
						count: count()
					})
					.from(this.table)
					.where(squeal);
				return res[0].count;
			}

			if (config.type === 'single') {
				return (await this.database.select().from(this.table).where(squeal).orderBy(this.table.created))[0];
			}

			const { offset, limit } = {
				offset: undefined,
				limit: undefined,
				...config,
			};
			if (offset && limit) {
				return this.database.select().from(this.table).where(squeal).orderBy(this.table.created).offset(offset).limit(limit);
			} else {
				return this.database.select().from(this.table).where(squeal).orderBy(this.table.created);
			}
		};

		if (config.type === 'stream') {
			const stream = new StructStream(this);
			setTimeout(async () => {
				const dataStream = (await get()) as Structable<T & typeof globalCols>[];
				for (let i = 0; i < dataStream.length; i++) {
					stream.add(this.Generator(dataStream[i] as any));
				}
				stream.end();
			});
			return stream;
		} else {
			return attemptAsync(async () => {
				const data = (await get()) as
					| Structable<T & typeof globalCols>[]
					| Structable<T & typeof globalCols>
					| number;
				if (Array.isArray(data)) {
					return data.map((d) => this.Generator(d));
				} else if (typeof data === 'object') {
					return this.Generator(data);
				} else {
					return data;
				}
			});
		}
	}

	// query() {
	// 	if (!this.built) {
	// 		throw new FatalStructError(
	// 			this,
	// 			'Cannot query struct before it is built. Please build the struct first.'
	// 		);
	// 	}
	// 	return this.database.select().from(this.table);
	// 	// return new StructQuery<T, Name>(this, this.database.select().from(this.table));
	// }

	/**
	 * Deletes all data from the struct
	 * This is a dangerous operation and should be used with caution
	 * It will not emit any events
	 *
	 * @returns {*}
	 */
	clear() {
		return attemptAsync(async () => {
			this.log('Clearing data...');
			await this.database.execute(sql`
				DELETE FROM ${this.table};
			`);
			
			if (this.versionTable) {
				this.log('Clearing version data...');
				await this.database.execute(sql`
					DELETE FROM ${this.versionTable};
				`);
			}
		});
	}

	/**
	 * Default data to be added to the struct when it is built
	 *
	 * @private
	 * @readonly
	 * @type {Structable<T & typeof globalCols>[]}
	 */
	private readonly defaults: Structable<T & typeof globalCols>[] = [];

	/**
	 * Create default StructData that will always be present in the struct, generated during build. Be sure to keep ids unique but not different between different execution times.
	 *
	 * @param {...Structable<T & typeof globalCols>[]} defaults
	 */
	addDefaults(...defaults: Structable<T & typeof globalCols>[]) {
		if (this.built)
			throw new FatalStructError(
				this,
				'Cannot add defaults after struct has been built. Those are applied during the build process.'
			);

		this.defaults.push(...defaults);
	}

	/**
	 * Retrieves all items that have a lifetime greater than 0. This is used to retrieve items that are not archived and have a lifetime set.
	 *
	 * @param {{
	 * 		type: 'stream';
	 * 		limit?: number;
	 * 		offset?: number;
	 * 	}} config 
	 * @returns {StructStream<T, Name>} 
	 */
	getLifetimeItems(config: {
		type: 'stream';
		limit?: number;
		offset?: number;
	}): StructStream<T, Name>;
	/**
	 * Retrieves all items that have a lifetime greater than 0. This is used to retrieve items that are not archived and have a lifetime set.
	 *
	 * @param {{
	 * 		type: 'array';
	 * 		limit: number;
	 * 		offset: number;
	 * 	}} config 
	 * @returns {ResultPromise<StructData<T, Name>[], Error>} 
	 */
	getLifetimeItems(config: {
		type: 'array';
		limit: number;
		offset: number;
	}): ResultPromise<StructData<T, Name>[], Error>;
	/**
	 * Retrieves all items that have a lifetime greater than 0. This is used to retrieve items that are not archived and have a lifetime set.
	 *
	 * @param {{
	 * 		type: 'single';
	 * 	}} config 
	 * @returns {(ResultPromise<StructData<T, Name> | undefined, Error>)} 
	 */
	getLifetimeItems(config: {
		type: 'single';
	}): ResultPromise<StructData<T, Name> | undefined, Error>;
	/**
	 * Retrieves all items that have a lifetime greater than 0. This is used to retrieve items that are not archived and have a lifetime set.
	 *
	 * @param {{ type: 'count' }} config 
	 * @returns {ResultPromise<number>} 
	 */
	getLifetimeItems(config: { type: 'count' }): ResultPromise<number>;
	/**
	 * Retrieves all items that have a lifetime greater than 0. This is used to retrieve items that are not archived and have a lifetime set.
	 *
	 * @param {{ type: 'all' }} config 
	 * @returns {ResultPromise<StructData<T, Name>[], Error>} 
	 */
	getLifetimeItems(config: { type: 'all' }): ResultPromise<StructData<T, Name>[], Error>;
	/**
	 * Retrieves all items that have a lifetime greater than 0. This is used to retrieve items that are not archived and have a lifetime set.
	 *
	 * @param {MultiConfig} config 
	 * @returns {(| StructStream<T, Name>
	 * 		| ResultPromise<StructData<T, Name>[] | undefined | StructData<T, Name> | number, Error>)} 
	 */
	getLifetimeItems(
		config: MultiConfig
	):
		| StructStream<T, Name>
		| ResultPromise<StructData<T, Name>[] | undefined | StructData<T, Name> | number, Error> {
		const get = async () => {
			if (isTesting(this)) {
				const table = TestTable.get(this.data.name);
				if (!table) throw noTableError(this);
				return table.getLifetimeItems().unwrap().map(d => d.data);
			}

			// const squeal = sql`${this.table.lifetime} > 0 AND ${this.table.archived} = ${false}`;
			let squeal: SQL;
			if (config.includeArchived) {
				squeal = sql`${this.table.lifetime} > 0`;
			} else {
				squeal = sql`${this.table.lifetime} > 0 AND ${this.table.archived} = ${false}`;
			}

			if (config.type === 'count') {
				const res = await this.database
					.select({
						count: count()
					})
					.from(this.table)
					.where(squeal);
				return res[0].count;
			}

			if (config.type === 'single') {
				return (await this.database.select().from(this.table).where(squeal))[0];
			}

			const { offset, limit } = {
				offset: undefined,
				limit: undefined,
				...config,
			};
			if (offset && limit) {
				return this.database.select().from(this.table).where(squeal).offset(offset).limit(limit);
			} else {
				return this.database.select().from(this.table).where(squeal);
			}
		};

		if (config.type === 'stream') {
			const stream = new StructStream(this);
			setTimeout(async () => {
				const dataStream = (await get()) as Structable<T & typeof globalCols>[];
				for (let i = 0; i < dataStream.length; i++) {
					stream.add(this.Generator(dataStream[i] as any));
				}
				stream.end();
			});
			return stream;
		} else {
			return attemptAsync(async () => {
				const data = (await get()) as
					| Structable<T & typeof globalCols>[]
					| Structable<T & typeof globalCols>
					| number;
				if (Array.isArray(data)) {
					return data.map((d) => this.Generator(d));
				} else if (typeof data === 'object') {
					return this.Generator(data);
				} else {
					return data;
				}
			});
		}
	}

	// select() {
	//     return this.database.select().from(this.table);
	// }

	/**
	 * Iterates over all data in the struct
	 *
	 * @param {(data: StructData<T, Name>, i: number) => void} fn
	 * @returns {void) => any}
	 */
	each(fn: (data: StructData<T, Name>, i: number) => void) {
		return this.all({
			type: 'stream'
		}).pipe(fn);
	}

	/**
	 * Builds the struct
	 *
	 * @param {PostgresJsDatabase} database The database to build the struct in
	 * @param {?(event: RequestAction) => Promise<Response> | Response} [handler] The event handler for the struct (sveltekit)
	 * @returns {any) => any}
	 */
	build(
		database: PostgresJsDatabase,
		// handler?: (event: RequestAction) => Promise<Response> | Response
	) {
		if (this.built) throw new FatalStructError(this, `Struct ${this.name} has already been built`);
		if (this.data.sample)
			throw new FatalStructError(
				this,
				`Struct ${this.name} is a sample struct and should never be built`
			);
		return attemptAsync(async () => {
			this.log('Building...');
			this._database = database;

			resolveAll(
				await Promise.all(
					this.defaults.map((d) => {
						return attemptAsync(async () => {
							const exists = (await this.fromId(d.id)).unwrap();
							if (exists) return;
							const res = this.validate(d);
							if (!res.success) throw new DataError(this, `Invalid default data: ${res.reason}`);
							this.log('Generating default:', d);
							this.database.insert(this.table).values(d as any);
						});
					})
				)
			).unwrap();

			// if (handler) {
			// 	this.eventHandler(handler);
			// }

			this.built = true;

			this.emit('build');
			this.log('Built!');
		});
	}

	/**
	 * Uses zod to validate the data
	 *
	 * @param {unknown} data Data to validate
	 * @param {?{ optionals?: string[]; not?: string[] }} [config] Configuration for the validation
	 * @returns {boolean}
	 */
	validate(
		data: unknown,
		config?: { optionals?: string[]; not?: string[] }
	):
		| {
				success: true;
		  }
		| {
				success: false;
				reason: string;
		  } {
		if (data === null || Array.isArray(data) || typeof data !== 'object')
			return {
				success: false,
				reason: 'Data is not an object'
			};

		const keys = Object.keys(data);
		if (config?.not) {
			const keySet = new Set(keys);
			for (const n of config.not) {
				if (keySet.has(n))
					return {
						success: false,
						reason: `Data contains key that should not exist: ${n}`
					};
			}
		}

		const createSchema = (type: z.ZodType, key: string) =>
			config?.optionals?.includes(key) ? type.optional() : type;

		const res = z
			.object({
				id: createSchema(z.string(), 'id'),
				created: createSchema(
					z.date().refine((arg) => arg.toString() !== 'Invalid Date'),
					'created'
				),
				updated: createSchema(
					z.date().refine((arg) => arg.toString() !== 'Invalid Date'),
					'updated'
				),
				archived: createSchema(z.boolean(), 'archived'),
				attributes: createSchema(z.string(), 'attributes'),
				lifetime: createSchema(z.number(), 'lifetime'),
				canUpdate: createSchema(z.boolean(), 'canUpdate'),
				...Object.fromEntries(
					Object.entries(this.data.structure).map(([k, v]) => {
						if (this.data.validators && this.data.validators[k]) {
							const validator = this.data.validators[k];
							if (validator instanceof z.ZodType) {
								return [k, createSchema(validator, k)];
							} else {
								return [k, createSchema(z.unknown().refine((d) => {
                                    try {
                                        return validator(d);
                                    } catch (error) {
                                        this.log('Error running validator', k, error);
                                        return false;
                                    }
                                }), k)];
							}
						}
						const type = (v as any).config.dataType as ColumnDataType;
						const schemaType = (() => {
							switch (type) {
								case 'number':
									return z.number();
								case 'string':
									return z.string();
								case 'boolean':
									return z.boolean();
								case 'date':
									return z.date();
								default:
									throw new DataError(this, `Invalid data type: ${type} in ${k} of ${this.name}`);
							}
						})();
						return [k, createSchema(schemaType, k)];
					})
				)
			})
			.strict()
			.safeParse(data); // Disallow additional keys

		if (res.success)
			return {
				success: true
			};
		return {
			success: false,
			reason: res.error.message
		};
	}

	/**
	 * Generates a Zod schema for the struct data
	 *
	 * @param {?{
	 * 		optionals?: (keyof T & keyof typeof globalCols)[];
	 * 		not?: (keyof T & keyof typeof globalCols)[];
	 * 	}} [config] 
	 * @returns {*} 
	 */
	getZodSchema(config?: {
		optionals?: (keyof T & keyof typeof globalCols)[];
		not?: (keyof T & keyof typeof globalCols)[];
	}) {
		const createSchema = (type: z.ZodType, key: string) =>
			config?.optionals?.includes(key as any) ? type.optional() : type;

		return z.object({
			id: createSchema(z.string(), 'id'),
			created: createSchema(z.date(), 'created'),
			updated: createSchema(z.date(), 'updated'),
			archived: createSchema(z.boolean(), 'archived'),
			attributes: createSchema(z.string(), 'attributes'),
			lifetime: createSchema(z.number(), 'lifetime'),
			canUpdate: createSchema(z.boolean(), 'canUpdate'),
			...Object.fromEntries(
				Object.entries(this.data.structure).map(([k, v]) => {
					if (this.data.validators && this.data.validators[k]) {
						const validator = this.data.validators[k];
						if (validator instanceof z.ZodType) {
							return [k, createSchema(validator, k)];
						} else {
							return [k, createSchema(z.unknown().refine(validator), k)];
						}
					}
					const type = (v as any).config.dataType as ColumnDataType;
					const schemaType = (() => {
						switch (type) {
							case 'number':
								return z.number();
							case 'string':
								return z.string();
							case 'boolean':
								return z.boolean();
							case 'date':
								return z.date();
							default:
								throw new DataError(this, `Invalid data type: ${type} in ${k} of ${this.name}`);
						}
					})();
					return [k, createSchema(schemaType, k)];
				})
			)
		});
	}

	/**
	 * Hashes the data in the struct
	 *
	 * @returns {*}
	 */
	hash() {
		return attemptAsync(async () => {
			this.log('Hashing');
			const encoder = new TextEncoder();
			let data: string = '';
			const promises: Promise<void>[] = [];
			await this.all({
				type: 'stream'
			}).pipe(async (d) => {
				const p = (async () => {
					const buffer = encoder.encode(JSON.stringify(d.data));
					const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
					const hashArray = Array.from(new Uint8Array(hashBuffer));
					data += hashArray.map((b) => b.toString(16).padStart(2, '0')).join(',');
				})();
				promises.push(p);
			});

			await Promise.all(promises);
			data = data.split(',').sort().join('');

			const buffer = encoder.encode(data);
			const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
			const hashArray = Array.from(new Uint8Array(hashBuffer));
			return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
		});
	}

	/**
	 * All bypass permissions for the struct
	 *
	 * @public
	 * @readonly
	 * @type {{
	 *         action: DataAction | PropertyAction | '*';
	 *         condition: (account: Account, data?: any) => boolean;
	 *     }[]}
	 */
	public readonly bypasses: {
		action: DataAction | PropertyAction | '*';
		condition: (account: Account, data?: any) => boolean;
	}[] = [];

	/**
	 * Allows an account to bypass a certain action
	 * This is useful for allowing certain accounts to have access to their data or data they have created without needing to go through the normal permissions system
	 *
	 * This may be removed since it doesn't really fit into the scope of Structs
	 *
	 * @template {DataAction | PropertyAction | '*'} Action
	 * @param {Action} action
	 * @param {(account: Account, data?: Structable<T & typeof globalCols>) => boolean} condition
	 * @returns {boolean) => void}
	 */
	bypass<Action extends DataAction | PropertyAction | '*'>(
		action: Action,
		condition: (account: Account, data?: Structable<T & typeof globalCols>) => boolean
	) {
		runFrontendWarn();
		this.log('Added bypass');
		this.bypasses.push({ action, condition });
	}

	/**
	 * Logs data to the console with a blue prefix
	 *
	 * @param {...unknown[]} data 
	 */
	log(...data: unknown[]) {
		if (this.data.log) console.log(chalk.blue(`[${this.name}]`), ...data);
	}

	/**
	 * A map of query listeners for the struct
	 *
	 * @public
	 * @readonly
	 * @type {*}
	 */
	public readonly queryListeners = new Map<
		string,
		{
			fn: (
				event: RequestEvent,
				data: unknown
			) => QueryReturnType<T, Name> | Promise<QueryReturnType<T, Name>>;
			filter?: (data: StructData<T, Name>) => boolean;
		}
	>();

	/**
	 * Listens for queries on the struct from the front end
	 *
	 * @param {string} event 
	 * @param {(
	 * 			event: RequestEvent,
	 * 			data: unknown
	 * 		) => QueryReturnType<T, Name> | Promise<QueryReturnType<T, Name>>} fn 
	 * @param {?(data: StructData<T, Name>) => boolean} [filter] 
	 * @returns {any, filter?: (data: StructData<T, Name>) => boolean) => void} 
	 */
	queryListen(
		event: string,
		fn: (
			event: RequestEvent,
			data: unknown
		) => QueryReturnType<T, Name> | Promise<QueryReturnType<T, Name>>,
		filter?: (data: StructData<T, Name>) => boolean
	) {
		runFrontendWarn();
		this.queryListeners.set(event, {
			fn,
			filter
		});
	}

	/**
	 * A map of call listeners for the struct
	 *
	 * @public
	 * @readonly
	 * @type {*}
	 */
	public readonly callListeners = new Map<
		string,
		(event: RequestEvent, data: unknown) => StructStatus | Promise<StructStatus>
	>();

	/**
	 * Listens for calls on the struct from the front end
	 *
	 * @param {string} event 
	 * @param {(event: RequestEvent, data: unknown) => StructStatus | Promise<StructStatus>} fn 
	 * @returns {any) => void} 
	 */
	callListen(
		event: string,
		fn: (event: RequestEvent, data: unknown) => StructStatus | Promise<StructStatus>
	) {
		runFrontendWarn();
		this.callListeners.set(event, fn);
	}

	/**
	 * A map of send listeners for the struct
	 *
	 * @public
	 * @readonly
	 * @type {*}
	 */
	public readonly sendListeners = new Map<
		string,
		(event: RequestEvent, data: unknown) => unknown
	>();

	/**
	 * Listens for send events on the struct from the front end
	 *
	 * @param {string} event 
	 * @param {(event: RequestEvent, data: unknown) => unknown} fn 
	 * @returns {unknown) => void} 
	 */
	sendListen(event: string, fn: (event: RequestEvent, data: unknown) => unknown) {
		runFrontendWarn();
		this.sendListeners.set(event, fn);
	}

	/**
	 * A 
	 *
	 * @public
	 * @readonly
	 * @type {*}
	 */
	public readonly blocks = new Map<
		string,
		{
			fn: (event: RequestEvent, data: unknown) => boolean | Promise<boolean>;
			reason: string;
		}[]
	>();

	/**
	 * Blocks a certain event from being processed
	 *
	 * @param {(DataAction | PropertyAction)} event 
	 * @param {(event: RequestEvent, data: unknown) => boolean | Promise<boolean>} fn 
	 * @param {string} reason 
	 * @returns {any, reason: string) => void} 
	 */
	block(
		event: DataAction | PropertyAction,
		fn: (event: RequestEvent, data: unknown) => boolean | Promise<boolean>,
		reason: string
	) {
		runFrontendWarn();
		if (!this.blocks.has(event)) {
			this.blocks.set(event, []);
		}
		this.blocks.get(event)?.push({
			fn,
			reason
		});
		this.log('Added block for', event, 'with reason:', reason);
	}

	/**
	 * Creates a backup of the struct data in a specified directory.
	 *
	 * @param {string} dir 
	 * @returns {*} 
	 */
	backup(dir: string) {
		return attemptAsync(async () => {
			if (isTesting(this)) {
				throw new Error('Cannot backup a struct that is currently in testing mode');
			}
			if (!fs.existsSync(dir)) {
				await fs.promises.mkdir(dir, { recursive: true });
			}

			const file = `${this.name}-${new Date().toISOString()}.backupv1`;
			this.log('Backing up:', file);

			const data = (
				await this.all({
					type: 'stream'
				}).await()
			).unwrap();

			await fs.promises.writeFile(
				path.join(dir, file),
				JSON.stringify(
					data.map((d) => d.data),
					(self, val) => {
						if (val instanceof Date) return '[DATE]:' + val.toISOString();
						// if is json
						if (typeof val === 'string') {
							try {
								JSON.parse(val);
								return '[JSON]:' + val;
							} catch {
								// do nothing
							}
						}
						return val;
					}
				)
			);

			// const stream = this.all({
			//     type: 'stream',
			// });

			// const ws = fs.createWriteStream(path.join(dir, file));
			// const promises: Promise<void>[] = [];
			// await stream.pipe(d => {
			//     promises.push(new Promise<void>((res) => {
			//         ws.write(encode(JSON.stringify(d.data, (self, val) => {
			//             if (val instanceof Date) return val.toISOString();
			//             // if is json
			//             if (typeof val === 'string') {
			//                 try {
			//                     JSON.parse(val);
			//                     return '[JSON]:' + val;
			//                 } catch {
			//                     // do nothing
			//                 }
			//             }
			//             return val;
			//         })) + '\n');
			//         sleep(1).then(() => res());
			//     }));
			// });

			// await Promise.all(promises);
			// ws.end();
		});
	}

	/**
	 * Restores the struct data from a backup file.
	 *
	 * @param {string} file 
	 * @returns {*} 
	 */
	restore(file: string) {
		return attemptAsync(async () => {
			if (isTesting(this)) {
				throw new Error('Cannot restore a struct that is currently in testing mode');
			}
			(await this.backup(path.dirname(file))).unwrap();
			(await this.clear()).unwrap();

			const data = z.array(z.unknown()).parse(
				JSON.parse(await fs.promises.readFile(file, 'utf-8'), (self, val) => {
					if (typeof val === 'string') {
						// if date
						// if (val.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/)) {
						//     return new Date(val);
						// }
						if (val.startsWith('[DATE]:')) return new Date(val.slice(7));
						if (val.startsWith('[JSON]:')) return val.slice(7);
					}
					return val;
				})
			);

			return resolveAll(
				await Promise.all(
					data.map((d) => {
						return attemptAsync(async () => {
							const res = this.validate(d);
							if (!res.success) {
								console.error('Invalid data:', res.reason, d);
							} else {
								(
									await this.new(d as any, {
										overwriteGlobals: true,
										overwriteGenerators: true
									})
								).unwrap();
							}
						});
					})
				)
			);

			// return new Promise<void>((res, rej) => {
			//     this.log('Restoring:', file);

			//     const filestream = fs.createReadStream(file);

			//     const rl = readline.createInterface({
			//         input: filestream,
			//         crlfDelay: Infinity,
			//     });

			//     rl.on('line', async line => {
			//         try {
			//             const data = JSON.parse(decode(line), (self, val) => {
			//                 if (typeof val === 'string') {
			//                     // if date
			//                     if (val.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/)) {
			//                         return new Date(val);
			//                     }
			//                     if (val.startsWith('[JSON]:')) return val.slice(7);
			//                 }
			//                 return val;
			//             });
			//             const res = this.validate(data);
			//             if (!res.success) {
			//                 console.error('Invalid data:', res.reason, data);
			//                 return;
			//             }
			//             (await this.new(data as any, {
			//                 overwriteGlobals: true,
			//                 overwriteGenerators: true,
			//             })).unwrap();
			//         } catch (err) {
			//             console.error(err);
			//         }
			//     });

			//     rl.on('close', res);
			// });
		});
	}
}


// // TODO: build a smaller version of the struct, fewer headers
// export class SmallStruct<T extends Blank, N extends string> {

// }




/**
 * Type representing the return type of a query on a struct.
 *
 * @export
 * @typedef {QueryReturnType}
 * @template {Blank} T 
 * @template {string} Name 
 */
export type QueryReturnType<T extends Blank, Name extends string> = 
	StructStream<T, Name> | 
	StructData<T, Name>[] |
	Error;

/**
 * Interface for accounts, used for bypasses.
 *
 * @export
 * @interface Account
 * @typedef {Account}
 */
// export interface Account {
// 	/**
// 	 * Data for the account
// 	 *
// 	 * @type {{
// 	 *         id: string;
// 	 *         username: string;
// 	 *         firstName: string;
// 	 *         lastName: string;
// 	 *         verified: boolean;
// 	 *         email: string;
// 	 *     }}
// 	 */
// 	data: {
// 		id: string;
// 		username: string;
// 		firstName: string;
// 		lastName: string;
// 		verified: boolean;
// 		email: string;
// 	};

// 	/**
// 	 * ID of the account
// 	 *
// 	 * @readonly
// 	 * @type {string}
// 	 */
// 	get id(): string;
// }

const accountSampleStructCols = {
	username: text('username').notNull().unique(),
	key: text('key').notNull().unique(),
	salt: text('salt').notNull(),
	firstName: text('first_name').notNull(),
	lastName: text('last_name').notNull(),
	email: text('email').notNull().unique(),
	verified: boolean('verified').notNull(),
	verification: text('verification').notNull(),
	lastLogin: text('last_login').notNull().default(''),
};

/**
 * Account data structure, used for storing account information.
 *
 * @export
 * @typedef {Account}
 */
export type Account = StructData<typeof accountSampleStructCols, 'account'>;

/**
 * Sample structure for a session, used for tracking user sessions.
 *
 * @type {{ accountId: any; ip: any; userAgent: any; requests: any; prevUrl: any; tabs: any; }}
 */
const sessionSampleStructCols = {
	accountId: text('account_id').notNull(),
	ip: text('ip').notNull(),
	userAgent: text('user_agent').notNull(),
	requests: integer('requests').notNull(),
	prevUrl: text('prev_url').notNull(),
	tabs: integer('tabs').notNull().default(0),
}

/**
 * Session data structure, used for tracking user sessions.
 *
 * @export
 * @typedef {Session}
 */
export type Session = StructData<typeof sessionSampleStructCols, 'session'>;


// const test = new Struct({
//     name: 'test',
//     structure: {
//         name: text('name').notNull(),
//         age: text('age').notNull(),
//     },
//     safes: ['age']
// });

// test.sample.safe().age;});