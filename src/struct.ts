/* eslint-disable @typescript-eslint/no-explicit-any */
import { pgTable, text, boolean, integer, timestamp } from 'drizzle-orm/pg-core';
import type { PgColumnBuilderBase, PgTableWithColumns } from 'drizzle-orm/pg-core';
import { count, inArray, SQL, sql, type BuildColumns } from 'drizzle-orm';
import { attempt, attemptAsync, resolveAll, ResultPromise } from 'ts-utils/check';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { type ColumnDataType } from 'drizzle-orm';
import { ComplexEventEmitter } from 'ts-utils/event-emitter';
import { Loop } from 'ts-utils/loop';
import { Stream } from 'ts-utils/stream';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { log } from './utils';
import path from 'path';
import fs from 'fs';
import { RedisStructProxyClient, RedisStructProxyServer } from './redis-struct-proxy';
import xxhash, { XXHashAPI } from 'xxhash-wasm';
import { StructError, DataError, FatalDataError, FatalStructError } from './utils';
import { DataVersion } from './struct-data-version';
import { StructData } from './struct-data';

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
	proxyClient?: RedisStructProxyClient<string, string, string>;

	/**
	 * Sets up the host for the data for other microservices to connect to
	 */
	proxyServer?: RedisStructProxyServer<string, string>;
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
	created: timestamp('created', { withTimezone: true })
		.notNull()
		.default(sql`now()`),
	updated: timestamp('updated', { withTimezone: true })
		.notNull()
		.default(sql`now()`),
	archived: boolean<'archived'>('archived').default(false).notNull(),
	attributes: text('attributes').notNull(),
	lifetime: integer('lifetime').notNull(),
	canUpdate: boolean<'can_update'>('can_update').default(true).notNull(),
	hash: text('hash').notNull().default('')
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
};

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
	vhCreated: timestamp('vh_created', { withTimezone: true })
		.notNull()
		.default(sql`now()`)
};

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
	update: [
		{
			from: Structable<T & typeof globalCols>;
			to: StructData<T, Name>;
		}
	];
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

	/**
	 * Emitted when the struct is connected to the redis proxy server
	 */
	connect: void;
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
			: T extends 'date'
				? Date
				: never;

type ISOString = `${number}-${number}-${number}T${number}:${number}:${number}.${number}Z`;

export type SafeTsType<T extends ColumnDataType> = T extends 'string'
	? string
	: T extends 'number'
		? number
		: T extends 'boolean'
			? boolean
			: T extends 'date'
				? ISOString
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
export type MultiConfig =
	| {
			type: 'stream';
			includeArchived?: boolean;
	  }
	| {
			type: 'array';
			includeArchived?: boolean;
			limit: number;
			offset: number;
	  }
	| {
			type: 'single';
			includeArchived?: boolean;
	  }
	| {
			type: 'count';
			includeArchived?: boolean;
	  }
	| {
			type: 'all';
			includeArchived?: boolean;
	  };

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
	 * @returns {any) => unknown}
	 */
	public static buildAll(database: PostgresJsDatabase) {
		return attemptAsync(async () => {
			return resolveAll(
				await Promise.all([...Struct.structs.values()].map((s) => s.build(database /*handler*/)))
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
				return this.data.proxyClient
					.new(this, data)
					.unwrap()
					.then((d) => this.Generator(d as any));
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

			const hash = await this.computeHash(data).unwrap();

			const globals = {
				id: this.data.generators?.id?.(data) ?? uuid(),
				created: new Date(),
				updated: new Date(),
				archived: false,
				hash,
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
			if (this.data.proxyClient) {
				return this.data.proxyClient.fromId(this, id).unwrap();
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
			if (this.data.proxyClient) {
				return this.data.proxyClient
					.fromVhId(this, vhId)
					.unwrap()
					.then((d) => (d ? new DataVersion(this, d as any) : undefined));
			}

			if (!this.versionTable) {
				throw new FatalStructError(this, `Struct ${this.name} does not have a version table`);
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
	all(config: {
		type: 'single';
		includeArchived?: boolean;
	}): ResultPromise<StructData<T, Name> | undefined, Error>;
	/**
	 * Retrieves all data from the struct based on the config provided.
	 *
	 * @param {{ type: 'count'; includeArchived?: boolean; }} config
	 * @returns {ResultPromise<number>}
	 */
	all(config: { type: 'count'; includeArchived?: boolean }): ResultPromise<number>;
	/**
	 * Retrieves all data from the struct based on the config provided.
	 *
	 * @param {{ type: 'all'; includeArchived?: boolean; }} config
	 * @returns {ResultPromise<StructData<T, Name>[], Error>}
	 */
	all(config: {
		type: 'all';
		includeArchived?: boolean;
	}): ResultPromise<StructData<T, Name>[], Error>;
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
			if (this.data.proxyClient) {
				return this.data.proxyClient.all(this, config).unwrap();
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
				return (
					await this.database.select().from(this.table).where(squeal).orderBy(this.table.created)
				)[0];
			}

			const { offset, limit } = {
				offset: undefined,
				limit: undefined,
				...config
			};
			if (offset !== undefined && limit !== undefined) {
				return this.database
					.select()
					.from(this.table)
					.where(squeal)
					.orderBy(this.table.created)
					.offset(offset)
					.limit(limit);
			} else {
				return this.database.select().from(this.table).where(squeal).orderBy(this.table.created);
			}
		};

		if (config.type === 'stream') {
			const stream = new StructStream(this);
			setTimeout(async () => {
				try {
					const dataStream = (await get()) as Structable<T & typeof globalCols>[];
					for (let i = 0; i < dataStream.length; i++) {
						stream.add(this.Generator(dataStream[i] as any));
					}
				} catch {
					//
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
			if (this.data.proxyClient) {
				return this.data.proxyClient
					.archived(this, {
						...(config as any),
						includeArchived: true,
						type: config.type === 'stream' ? 'all' : config.type
					})
					.unwrap();
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
				return (
					await this.database.select().from(this.table).where(squeal).orderBy(this.table.created)
				)[0];
			}

			const { offset, limit } = config;
			if (offset && limit) {
				return this.database
					.select()
					.from(this.table)
					.where(squeal)
					.orderBy(this.table.created)
					.offset(offset)
					.limit(limit);
			} else {
				return this.database.select().from(this.table).where(squeal).orderBy(this.table.created);
			}
		};

		if (config.type === 'stream') {
			const stream = new StructStream(this);
			setTimeout(async () => {
				try {
					const dataStream = (await get()) as Structable<T & typeof globalCols>[];
					for (let i = 0; i < dataStream.length; i++) {
						stream.add(this.Generator(dataStream[i] as any));
					}
				} catch {
					//
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
			if (this.data.proxyClient) {
				return this.data.proxyClient
					.fromProperty(this, property as string, value, {
						...(config as any),
						type: config.type === 'stream' ? 'all' : config.type
					})
					.unwrap();
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
				return (
					await this.database.select().from(this.table).where(squeal).orderBy(this.table.created)
				)[0];
			}

			const { offset, limit } = {
				offset: undefined,
				limit: undefined,
				...config
			};
			if (offset && limit) {
				return this.database
					.select()
					.from(this.table)
					.where(squeal)
					.orderBy(this.table.created)
					.offset(offset)
					.limit(limit);
			} else {
				return this.database.select().from(this.table).where(squeal).orderBy(this.table.created);
			}
		};

		if (config.type === 'stream') {
			const stream = new StructStream(this);
			setTimeout(async () => {
				try {
					const dataStream = (await get()) as Structable<T & typeof globalCols>[];
					for (let i = 0; i < dataStream.length; i++) {
						stream.add(this.Generator(dataStream[i] as any));
					}
				} catch {
					//
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
		const get = async () => {
			if (this.data.proxyClient) {
				return this.data.proxyClient
					.get(this, props, {
						...(config as any),
						type: config.type === 'stream' ? 'all' : config.type
					})
					.unwrap();
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
				return (
					await this.database.select().from(this.table).where(squeal).orderBy(this.table.created)
				)[0];
			}

			const { offset, limit } = {
				offset: undefined,
				limit: undefined,
				...config
			};
			if (offset && limit) {
				return this.database
					.select()
					.from(this.table)
					.where(squeal)
					.orderBy(this.table.created)
					.offset(offset)
					.limit(limit);
			} else {
				return this.database.select().from(this.table).where(squeal).orderBy(this.table.created);
			}
		};

		if (config.type === 'stream') {
			const stream = new StructStream(this);
			setTimeout(async () => {
				try {
					const dataStream = (await get()) as Structable<T & typeof globalCols>[];
					for (let i = 0; i < dataStream.length; i++) {
						stream.add(this.Generator(dataStream[i] as any));
					}
				} catch {
					//
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

	fromIds(
		ids: string[],
		config: {
			type: 'stream';
		}
	): StructStream<T, Name>;
	fromIds(
		ids: string[],
		config: {
			type: 'single';
		}
	): ResultPromise<StructData<T, Name> | undefined, Error>;
	fromIds(
		ids: string[],
		config: {
			type: 'count';
		}
	): ResultPromise<number>;
	fromIds(
		ids: string[],
		config: {
			type: 'all';
		}
	): ResultPromise<StructData<T, Name>[], Error>;
	fromIds(
		ids: string[],
		config: MultiConfig
	):
		| ResultPromise<StructData<T, Name>[] | StructData<T, Name> | undefined | number, Error>
		| StructStream<T, Name> {
		const get = async () => {
			if (this.data.proxyClient) {
				return this.data.proxyClient
					.fromIds(this, ids, {
						...(config as any),
						type: config.type === 'stream' ? 'all' : config.type
					})
					.unwrap();
			}

			const squeal = inArray(this.table.id as any, ids);

			return this.database.select().from(this.table).where(squeal).orderBy(this.table.created);
		};

		if (config.type === 'stream') {
			const stream = new StructStream(this);
			setTimeout(async () => {
				try {
					const dataStream = (await get()) as Structable<T & typeof globalCols>[];
					for (let i = 0; i < dataStream.length; i++) {
						stream.add(this.Generator(dataStream[i] as any));
					}
				} catch {
					//
				}
				stream.end();
			});
			return stream;
		} else {
			return attemptAsync(async () => {
				const data = (await get()) as
					| Structable<T & typeof globalCols>[]
					| Structable<T & typeof globalCols>;
				if (Array.isArray(data)) {
					return data.map((d) => this.Generator(d));
				} else {
					return this.Generator(data);
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
			if (this.data.proxyClient) {
				throw new StructError(this, 'Cannot clear data when using a proxy client');
			}
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

		if (this.data.proxyClient) {
			throw new StructError(this, 'Cannot add defaults when using a proxy client');
		}

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
			if (this.data.proxyClient) {
				return this.data.proxyClient
					.getLifetimeItems(this, {
						...(config as any),
						type: config.type === 'stream' ? 'all' : config.type,
						includeArchived: true
					})
					.unwrap();
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
				...config
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
				try {
					const dataStream = (await get()) as Structable<T & typeof globalCols>[];
					for (let i = 0; i < dataStream.length; i++) {
						stream.add(this.Generator(dataStream[i] as any));
					}
				} catch {
					//
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
		database: PostgresJsDatabase
		// handler?: (event: RequestAction) => Promise<Response> | Response
	) {
		if (this.data.sample)
			throw new FatalStructError(
				this,
				`Struct ${this.name} is a sample struct and should never be built`
			);
		return attemptAsync(async () => {
			if (this.built) {
				return;
			}
			this.log('Building...');
			this._database = database;

			if (this.data.proxyClient) {
				this.log('Using proxy client, skipping build process');
				this.built = true;
				this.emit('build');
				this.log('Built!');
				return;
			}

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
				hash: createSchema(z.string(), 'hash'),
				...Object.fromEntries(
					Object.entries(this.data.structure).map(([k, v]) => {
						if (this.data.validators && this.data.validators[k]) {
							const validator = this.data.validators[k];
							if (validator instanceof z.ZodType) {
								return [k, createSchema(validator, k)];
							} else {
								return [
									k,
									createSchema(
										z.unknown().refine((d) => {
											try {
												return validator(d);
											} catch (error) {
												this.log('Error running validator', k, error);
												return false;
											}
										}),
										k
									)
								];
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
	 * Logs data to the console with a blue prefix
	 *
	 * @param {...unknown[]} data
	 */
	log(...data: unknown[]) {
		if (this.data.log) console.log(
			// turn terminal blue
			'\x1b[34m',
			`[Struct:${this.name}]`,
			// reset
			'\x1b[0m',
			...data
		);
	}

	/**
	 * Creates a backup of the struct data in a specified directory.
	 *
	 * @param {string} dir
	 * @returns {*}
	 */
	backup(dir: string) {
		return attemptAsync(async () => {
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

	private _hashAlg: XXHashAPI | null = null;

	getHashAlg() {
		return attemptAsync<XXHashAPI>(async () => {
			if (!this._hashAlg) {
				this._hashAlg = await xxhash();
				return this._hashAlg;
			} else {
				return this._hashAlg;
			}
		});
	}

	computeHash(data: Record<string, unknown>) {
		return attemptAsync(async () => {
			const hash = await this.getHashAlg().unwrap();
			const hashData = { ...data };

			const str = Object.keys(hashData)
				.sort()
				.map((key) => {
					const val = (hashData as any)[key];
					if (val instanceof Date) {
						return `${key}:${val.toISOString()}`;
					} else if (typeof val === 'object' && val !== null) {
						return `${key}:${JSON.stringify(val)}`;
					} else {
						return `${key}:${val}`;
					}
				})
				.join(';');

			return hash.h64(str).toString(16);
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
	| StructStream<T, Name>
	| StructData<T, Name>[]
	| Error;
