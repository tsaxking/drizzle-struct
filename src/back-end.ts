/* eslint-disable @typescript-eslint/no-explicit-any */
import { pgTable, text, timestamp, boolean, integer } from 'drizzle-orm/pg-core';
import type { PgColumnBuilderBase, PgTableWithColumns } from 'drizzle-orm/pg-core';
import { sql, type BuildColumns } from 'drizzle-orm';
import { attempt, attemptAsync, resolveAll, type Result } from 'ts-utils/check';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { type ColumnDataType } from 'drizzle-orm';
import { EventEmitter } from 'ts-utils/event-emitter';
import { Loop } from 'ts-utils/loop';
import { Stream } from 'ts-utils/stream';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { DataAction, PropertyAction } from './types';
import { Client, QueryType, Server } from './reflection';
import { OnceReadMap } from 'ts-utils/map';

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
    constructor(message: string) {
        super(message);
        this.name = 'StructError';
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
    constructor(message: string) {
        super(message);
        this.name = 'FatalStructError';
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
    constructor(message: string) {
        super(message);
        this.name = 'DataError';
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
    constructor(message: string) {
        super(message);
        this.name = 'FatalDataError';
    }
}

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
    }
    /**.
     * If this struct is meant to communicate with a front-end struct
     */
    frontend?: boolean;
    /**
     * Configure how you want global columns to be generated
     */
    generators?: Partial<{
        id: () => string;
        attributes: () => string[];
        lifetime: () => number;
        universes: () => string[];
    }>;
    /**
     * Version history, if a data is updated, it will save the current state to a version table
     * If not set, there will be no version table
     */
    versionHistory?: {
        type: 'days' | 'versions';
        amount: number;
    };
    /**
     * The number of universes the data is allowed to be in, if not set, it defaults to 1
     */
    universeLimit?: number;
    // This is so the struct isn't actually permanently in the database, it 'reflects' a different server's data
    // If there are merge conflicts, it will always prioritize the other server's data
    // It will still save in the local database for optimization purposes
    // If there are type conflicts, they are incompatible, so it will throw an error
    // reflect?: {
    //     address: string;
    //     port: number;
    //     key: string;
    //     // How often it should sync with the other server
    //     // it will first send a hash of the data, and if the other server doesn't have that hash, the other server will pipe the data
    //     interval: number;
    // };
    /**
     * Configure how the reflection API works. Reflections are used to sync data between servers. If a server has a reflection, it will send data to the other server, and receive updates. If there are conflicts, it will prioritize the other server's data. If there are type conflicts, it will throw an error.
     * If not set, there will be no reflection.
     * 
     * Be sure to set up the reflection server as well.
     * ```ts
     * // Imported from 'drizzle-struct/reflection'
     * const api = new {Server/Client}(); // Configure respectively
     * 
     * const struct = new Struct(); // Configure struct
     * struct.startReflection(api); // Must be called for reflection to work
     * 
     */
    reflection?: {
        /**
         * The time, in milliseconds, between each sync.
         * Basically, if you call Struct.all() it will always return the data it has in the database. If this threshold is reached, it will query the other server for updates. If there are any changes, it will emit batch new/update events so you can handle them.
         */
        queryThreshold?: number;
    };
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
    created: timestamp<'created', 'string'>('created').notNull(),
    updated: timestamp<'updated', 'string'>('updated').notNull(),
    archived: boolean<'archived'>('archived').default(false).notNull(),
    universes: text('universes').notNull(),
    attributes: text('attributes').notNull(),
    lifetime: integer('lifetime').notNull(),
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
    dialect: "pg";
}>;

/**
 * A shallow object that is a single row in the database. By default, this does not include the global columns.
 *
 * @export
 * @typedef {Structable}
 * @template {Blank} T 
 */
export type Structable<T extends Blank> = {
    [K in keyof T]: TsType<T[K]['_']['dataType']>;// | TsType<T[K]['config']['dataType']>;
}

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
export class StructStream<T extends Blank = Blank, Name extends string = string> extends Stream<StructData<T, Name>> {
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
    vhCreated: timestamp<'vh_created', 'string'>('vh_created').notNull(),
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
    public readonly metadata = new OnceReadMap<string, string|boolean|number>();

    /**
     * Creates an instance of DataVersion.
     *
     * @constructor
     * @param {Struct<T, Name>} struct 
     * @param {Structable<T & typeof globalCols & typeof versionGlobalCols>} data 
     */
    constructor(public readonly struct: Struct<T, Name>, public readonly data: Structable<T & typeof globalCols & typeof versionGlobalCols>) {}

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
        return new Date(this.data.created);
    }

    /**
     * The date the data was last updated
     *
     * @readonly
     * @type {*}
     */
    get updated() {
        return new Date(this.data.updated);
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
    delete(config?: {
        emit?: boolean;
    }) {
        return attemptAsync(async () => {
            if (!this.struct.versionTable) throw new StructError(`Struct ${this.struct.name} does not have a version table`);
            await this.database.delete(this.struct.versionTable).where(sql`${this.struct.versionTable.vhId} = ${this.vhId}`);
            if (config?.emit || config?.emit === undefined) this.metadata.set('no-emit', true);
            this.struct.emit('delete-version', this);
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
    restore(config?: {
        emit?: boolean;
    }) {
        return attemptAsync(async () => {
            const data = (await this.struct.fromId(this.id)).unwrap();
            if (!data) this.struct.new(this.data);
            else await data.update(this.data);
            if (config?.emit || config?.emit === undefined) this.metadata.set('no-emit', true);
            this.struct.emit('restore-version', this);
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
    public readonly metadata = new OnceReadMap<string, string|boolean|number>();

    /**
     * Creates an instance of StructData.
     *
     * @constructor
     * @param {Readonly<Structable<T & typeof globalCols>>} data 
     * @param {Struct<T, Name>} struct 
     */
    constructor(public readonly data: Readonly<Structable<T & typeof globalCols>>, public readonly struct: Struct<T, Name>) {}

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
        return new Date(this.data.created);
    }

    /**
     * Date the data was last updated
     *
     * @readonly
     * @type {*}
     */
    get updated() {
        return new Date(this.data.updated);
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
     * Updates the data, this will emit an update event. If there is a version table, it will also make a version of the data of the state before the update
     *
     * @param {Partial<Structable<T>>} data 
     * @param {?{
     *         emit?: boolean;
     *     }} [config] 
     * @returns {*} 
     */
    update(data: Partial<Structable<T>>, config?: {
        emit?: boolean;
    }) {
        return attemptAsync(async () => {
            if (!this.struct.validate(this.data, {
                optionals: Object.keys(globalCols) as string[]
            })) {
                throw new DataError('Invalid Data');
            }
            this.makeVersion();
            this.metadata.set('prev-state', JSON.stringify(this.safe()));
            const newData: any = { ...this.data, ...data };

            // Remove global columns
            delete newData.id;
            delete newData.created;
            delete newData.updated;
            delete newData.archived;
            delete newData.universes;
            delete newData.attributes;
            delete newData.lifetime;
            await this.database.update(this.struct.table).set({
                ...newData,
                updated: new Date(),
            }).where(sql`${this.struct.table.id} = ${this.id}`);

            if (config?.emit || config?.emit === undefined) this.metadata.set('no-emit', true);
            this.struct.emit('update', this);
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
    setArchive(archived: boolean, config?: {
        emit?: boolean;
    }) {
        return attemptAsync(async () => {
            await this.struct.database.update(this.struct.table).set({
                archived,
                updated: new Date(),
            } as any).where(sql`${this.struct.table.id} = ${this.id}`);

            if (config?.emit || config?.emit === undefined) this.metadata.set('no-emit', true);
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
    delete(config?: {
        emit?: boolean;
    }) {
        return attemptAsync(async () => {
            this.makeVersion();
            await this.database.delete(this.struct.table).where(sql`${this.struct.table.id} = ${this.id}`);
            if (config?.emit || config?.emit === undefined) this.metadata.set('no-emit', true);
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
            if (!this.struct.versionTable) throw new StructError(`Struct ${this.struct.name} does not have a version table`);
            const vhId = uuid();
            const vhCreated = new Date();
            const vhData = { ...this.data, vhId, vhCreated } as any;
            await this.database.insert(this.struct.versionTable).values(vhData);

            const prev = (await this.getVersions()).unwrap();
            if (this.struct.data.versionHistory) {
                if (this.struct.data.versionHistory.type === 'days') {
                    const days = this.struct.data.versionHistory.amount;
                    const date = new Date();
                    date.setDate(date.getDate() - days);
                    const toDelete = prev.filter(v => v.vhCreated < date);
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
            if (!this.struct.versionTable) throw new StructError(`Struct ${this.struct.name} does not have a version table`);
            const data = await this.database.select().from(this.struct.versionTable).where(sql`${this.struct.versionTable.id} = ${this.id}`);
            return data.map(d => new DataVersion(this.struct, d as any));
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
            const a = JSON.parse(this.data.attributes);
            if (!Array.isArray(a)) throw new DataError('Attributes must be an array');
            if (!a.every(i => typeof i === 'string')) throw new DataError('Attributes must be an array of strings');
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
            attributes = attributes
                .filter(i => typeof i === 'string')
                .filter((v, i, a) => a.indexOf(v) === i);
            await this.database.update(this.struct.table).set({
                attributes: JSON.stringify(attributes),
                updated: new Date(),
            } as any).where(sql`${this.struct.table.id} = ${this.id}`);
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
            const a = this.getAttributes().unwrap();
            const newAttributes = a.filter(i => !attributes.includes(i));
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
            const a = this.getAttributes().unwrap();
            return (await this.setAttributes([...a, ...attributes])).unwrap()
        });
    }

    /**
     * Returns an array of universe Ids
     *
     * @returns {*} 
     */
    getUniverses() {
        return attempt(() => {
            const a = JSON.parse(this.data.universes);
            if (!Array.isArray(a)) throw new DataError('Universes must be an array');
            if (!a.every(i => typeof i === 'string')) throw new DataError('Universes must be an array of strings');
            return a;
        });
    }
    /**
     * Sets the universes
     *
     * @param {string[]} universes 
     * @returns {*} 
     */
    setUniverses(universes: string[]) {
        return attemptAsync(async () => {
            universes = universes
                .filter(i => typeof i === 'string')
                .filter((v, i, a) => a.indexOf(v) === i);
            await this.database.update(this.struct.table).set({
                universes: JSON.stringify(universes),
                updated: new Date(),
            } as any).where(sql`${this.struct.table.id} = ${this.id}`);
        });
    }
    /**
     * Removes universes
     *
     * @param {...string[]} universes 
     * @returns {*} 
     */
    removeUniverses(...universes: string[]) {
        return attemptAsync(async () => {
            const a = this.getUniverses().unwrap();
            const newUniverses = a.filter(i => !universes.includes(i));
            return (await this.setUniverses(newUniverses)).unwrap()
        });
    }
    /**
     * Adds universes
     *
     * @param {...string[]} universes 
     * @returns {*} 
     */
    addUniverses(...universes: string[]) {
        return attemptAsync(async () => {
            const a = this.getUniverses().unwrap();
            return (await this.setUniverses([...a, ...universes])).unwrap()
        });
    }

    /**
     * Returns a safe object of the data, omitting columns that you want removed.
     * This isn't typed properly yet, so don't trust the omit types yet.
     *
     * @param {?(keyof T & keyof typeof globalCols)[]} [omit] 
     * @returns {*} 
     */
    safe(omit?: (keyof T & keyof typeof globalCols)[]) {
        // TODO: Type the ommitted columns properly
        const data = { ...this.data };
        if (omit) {
            for (const key of omit) {
                delete data[key];
            }
        }
        return data;
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
        this.struct.emit('update', this);
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
export const toJson = <T extends Blank>(struct: Struct<T, string>, data: Structable<T & typeof globalCols>) => {
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
                    throw new DataError(`Invalid data type: ${type} in ${key} of ${struct.name}`);
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
    update: StructData<T, Name>;
    archive: StructData<T, Name>;
    delete: StructData<T, Name>;
    restore: StructData<T, Name>;
    create: StructData<T, Name>;
    build: void;

    'delete-version': DataVersion<T, Name>;
    'restore-version': DataVersion<T, Name>;
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
}

/**
 * Request action for sveltekit struct requests
 *
 * @export
 * @typedef {RequestAction}
 */
export type RequestAction = {
    action: DataAction | PropertyAction;
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
export type TsType<T extends ColumnDataType> = T extends 'string' ? string : T extends 'number' ? number : T extends 'boolean' ? boolean : T extends 'timestamp' ? Date : never;

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
     * Build all structs that the program has access to
     *
     * @public
     * @static
     * @async
     * @param {PostgresJsDatabase} database 
     * @param {?(event: RequestAction) => Promise<Response> | Response} [handler] 
     * @returns {any) => unknown} 
     */
    public static async buildAll(database: PostgresJsDatabase, handler?: (event: RequestAction) => Promise<Response> | Response) {
        return resolveAll(await Promise.all([...Struct.structs.values()].map(s => s.build(database, handler))));
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
     * Global event handler for sveltekit
     *
     * @public
     * @static
     * @param {RequestEvent} event 
     * @returns {Promise<Result<Response>>} 
     */
    public static handler(event: RequestEvent): Promise<Result<Response>> {
        return attemptAsync(async () => {
            const body: unknown = await event.request.json();

            if (typeof body !== 'object' || body === null) return new Response('Invalid body', { status: 400 });
            if (!Object.hasOwn(body, 'struct')) return new Response('Missing struct', { status: 400 });
            if (!Object.hasOwn(body, 'action')) return new Response('Missing action', { status: 400 });
            if (!Object.hasOwn(body, 'data')) return new Response('Missing data', { status: 400 });

            const B = body as { struct: string; action: DataAction | PropertyAction; data: unknown };

            const struct = Struct.structs.get(B.struct);
            if (!struct) return new Response('Struct not found', { status: 404 });

            const response = (await struct._eventHandler?.({ action: B.action, data: B.data, request: event, struct }));
            if (response) return response;

            return new Response('Not implemented', { status: 501 });
        });
    }

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
            Struct.each(async s => {
                s.getLifetimeItems(true).pipe(async d => {
                    if (d.lifetime === 0) return;
                    if (d.created.getTime() + d.lifetime < Date.now()) {
                        (await d.delete()).unwrap();
                    }
                });
            });
        }, time)
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
    public readonly versionTable?: Table<T & typeof globalCols & typeof versionGlobalCols, `${Name}_history`>;
    /**
     * Event emitter for this struct
     *
     * @public
     * @readonly
     * @type {*}
     */
    private readonly emitter = new EventEmitter<StructEvents<T, Name>>();

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
        Struct.structs.set(data.name, this as Struct);

        this.table = pgTable(data.name, {
            ...globalCols,
            ...data.structure,
        });

        if (data.versionHistory) {
            this.versionTable = pgTable(`${data.name}_history`, {
                ...globalCols,
                ...versionGlobalCols,
                ...data.structure,
            });
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
        if (!this._database) throw new FatalStructError('Struct database not set');
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
    new(data: Structable<T>, config?: {
        emit?: boolean;
        ignoreGlobals?: boolean;
    }) {
        return attemptAsync(async () => {
            this.validate(data, {
                optionals: config?.ignoreGlobals ? [] : Object.keys(globalCols) as string[],
            });
            const globals = {
                id: this.data.generators?.id?.() ?? uuid(),
                created: new Date(),
                updated: new Date(),
                archived: false,
                universes: JSON.stringify(this.data.generators?.universes?.() ?? []),
                attributes: JSON.stringify(this.data.generators?.attributes?.() ?? []),
                lifetime: this.data.generators?.lifetime?.() || 0,
            }
            const newData: Structable<T & typeof globalCols> = {
                ...data,
                ...(!config?.ignoreGlobals ? globals : {}),
            };

            await this.database.insert(this.table).values(newData as any);

            const d = this.Generator(newData);
            if (config?.emit || config?.emit === undefined) d.metadata.set('no-emit', true);
            this.emitter.emit('create', d);

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
            const data = await this.database.select().from(this.table).where(sql`${this.table.id} = ${id}`);
            const a = data[0];
            if (!a) {
                if (this._api) {
                    const apiQueryResult = (await this._api.query(this, 'from-id', {
                        id
                    })).unwrap();
                    if (!apiQueryResult) return;
                    return this.Generator(apiQueryResult as any);
                }
            }
            return this.Generator(a as any);
        });
    }

    /**
     * Streams all data requested by id from the database
     *
     * @param {string[]} ids IDs of the data to get
     * @param {true} asStream If the data should be streamed
     * @returns {StructStream<T, Name>} 
     */
    fromIds(ids: string[], asStream: true): StructStream<T, Name>;
    /**
     * Returns all data requested by id from the database
     *
     * @param {string[]} ids IDs of the data to get
     * @param {false} asStream If the data should be streamed
     * @returns {Promise<Result<StructData<T, Name>[], Error>>} 
     */
    fromIds(ids: string[], asStream: false): Promise<Result<StructData<T, Name>[], Error>>;
    /**
     * Streams/returns all data requested by id from the database
     *
     * @param {string[]} ids IDs of the data to get
     * @param {boolean} asStream If the data should be streamed
     * @returns 
     */
    fromIds(ids: string[], asStream: boolean) {
        const get = () => {
            this.apiQuery('from-ids', {
                ids,
            });

            return this.database.select().from(this.table).where(sql`${this.table.id} IN (${ids})`);
        }
        if (asStream) {
            const stream = new StructStream(this);
            (async () => {
                const dataStream = await get();
                for (let i = 0; i < dataStream.length; i++) {
                    stream.add(this.Generator(dataStream[i] as any));
                }
                stream.end();
            })();
            return stream;
        } else {
            return attemptAsync(async () => {
                const data = await get();
                return data.map(d => this.Generator(d as any));
            });
        }
    }

    // TODO: Integrate limits
    /**
     * Streams all data from the database
     *
     * @param {true} asStream If the data should be streamed
     * @param {?boolean} [includeArchived] If archived data should be included
     * @returns {StructStream<T, Name>} 
     */
    all(asStream: true, includeArchived?: boolean): StructStream<T, Name>;
    /**
     * Returns all data from the database. Please be careful with this, it can be a lot of data.
     *
     * @param {false} asStream If the data should be streamed
     * @param {?boolean} [includeArchived] If archived data should be included
     * @returns {Promise<Result<StructData<T, Name>[], Error>>} 
     */
    all(asStream: false, includeArchived?: boolean): Promise<Result<StructData<T, Name>[], Error>>;
    /**
     * Streams/returns all data from the database
     *
     * @param {boolean} asStream If the data should be streamed
     * @param {boolean} [includeArchived=false] If archived data should be included
     * @returns 
     */
    all(asStream: boolean, includeArchived = false){
        const get = async () => {
            this.apiQuery('all', {});

            return this.database.select().from(this.table).where(sql`${this.table.archived} = ${includeArchived}`);
        }
        if (asStream) {
            const stream = new StructStream(this);
            (async () => {
                const dataStream = await get();
                for (let i = 0; i < dataStream.length; i++) {
                    stream.add(this.Generator(dataStream[i] as any));
                }
                stream.end();
            })();
            return stream;
        } else {
            return attemptAsync(async () => {
                const data = await get();
                return data.map(d => this.Generator(d as any));
            });
        }
    }

    /**
     * Streams all data from the database that is archived
     *
     * @param {true} asStream If the data should be streamed
     * @returns {StructStream<T, Name>} 
     */
    archived(asStream: true): StructStream<T, Name>;
    /**
     * Returns all data from the database that is archived
     *
     * @param {false} asStream If the data should be streamed
     * @returns {Promise<Result<StructData<T, Name>[], Error>>} 
     */
    archived(asStream: false): Promise<Result<StructData<T, Name>[], Error>>;
    /**
     * Streams/returns all data from the database that is archived
     *
     * @param {boolean} asStream If the data should be streamed
     * @returns 
     */
    archived(asStream: boolean) {
        const get = () => {
            this.apiQuery('archived', {});
            return this.database.select().from(this.table).where(sql`${this.table.archived} = ${true}`);
        }
        if (asStream) {
            const stream = new StructStream(this);
            (async () => {
                const dataStream = await get();
                for (let i = 0; i < dataStream.length; i++) {
                    stream.add(this.Generator(dataStream[i] as any));
                }
                stream.end();
            })();
            return stream;
        } else {
            return attemptAsync(async () => {
                const data = await get();
                return data.map(d => this.Generator(d as any));
            });
        }
    }

    /**
     * Streams all data from the database that is not archived
     *
     * @template {keyof T} K 
     * @param {K} property  The property to search for
     * @param {TsType<T[K]['_']['dataType']>} value The value to search for
     * @param {true} asStream If the data should be streamed
     * @returns {StructStream<T, Name>} 
     */
    fromProperty<K extends keyof T>(property: K, value: TsType<T[K]['_']['dataType']>, asStream: true): StructStream<T, Name>;
    /**
     * Returns all data from the database that is not archived
     *
     * @template {keyof T} K 
     * @param {K} property The property to search for
     * @param {TsType<T[K]['_']['dataType']>} value The value to search for
     * @param {false} asStream If the data should be streamed
     * @returns {Promise<Result<StructData<T, Name>[], Error>>} 
     */
    fromProperty<K extends keyof T>(property: K, value: TsType<T[K]['_']['dataType']>, asStream: false): Promise<Result<StructData<T, Name>[], Error>>;
    /**
     * Streams/returns all data from the database that is not archived
     *
     * @template {keyof T} K 
     * @param {K} property The property to search for
     * @param {TsType<T[K]['_']['dataType']>} value The value to search for
     * @param {boolean} asStream If the data should be streamed
     * @returns 
     */
    fromProperty<K extends keyof T>(property: K, value: TsType<T[K]['_']['dataType']>, asStream: boolean) {
        const get = () => {
            this.apiQuery('from-property', {
                property: String(property),
                value,
            });
            return this.database.select().from(this.table).where(sql`${this.table[property]} = ${value} AND ${this.table.archived} = ${false}`);
        }
        if (asStream) {
            const stream = new StructStream(this);
            (async () => {
                const dataStream = await get();
                for (let i = 0; i < dataStream.length; i++) {
                    stream.add(this.Generator(dataStream[i] as any));
                }
                stream.end();
            })();
            return stream;
        } else {
            return attemptAsync(async () => {
                const data = await get();
                return data.map(d => this.Generator(d as any));
            });
        }
    }
    /**
     * Streams all data from the database that is not archived
     *
     * @param {string} universe The universe to search for
     * @param {true} asStream If the data should be streamed
     * @returns {StructStream<T, Name>} 
     */
    fromUniverse(universe: string, asStream: true): StructStream<T, Name>;
    /**
     * Returns all data from the database that is not archived
     *
     * @param {string} universe The universe to search for
     * @param {false} asStream If the data should be streamed
     * @returns {Promise<Result<StructData<T, Name>[], Error>>} 
     */
    fromUniverse(universe: string, asStream: false): Promise<Result<StructData<T, Name>[], Error>>;
    /**
     * Streams/returns all data from the database that is not archived
     *
     * @param {string} universe The universe to search for
     * @param {boolean} asStream If the data should be streamed
     * @returns 
     */
    fromUniverse(universe: string, asStream: boolean) {
        const get = () => {
            this.apiQuery('from-universe', {
                universe,
            });
            return this.database.select().from(this.table).where(sql`${this.table.universes} LIKE ${`%${universe}%`} AND ${this.table.archived} = ${false}`);
        }
        if (asStream) {
            const stream = new StructStream(this);
            (async () => {
                const dataStream = await get();
                for (let i = 0; i < dataStream.length; i++) {
                    stream.add(this.Generator(dataStream[i] as any));
                }
                stream.end();
            })();
            return stream;
        } else {
            return attemptAsync(async () => {
                const data = await get();
                return data.map(d => this.Generator(d as any));
            });
        }
    }

    /**
     * Deletes all data from the struct
     * This is a dangerous operation and should be used with caution
     * It will not emit any events
     *
     * @returns {*} 
     */
    clear() {
        return attemptAsync(async () => {
            return this.database.delete(this.table).where(sql`true`);
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
        if (this.built) throw new FatalStructError('Cannot add defaults after struct has been built. Those are applied during the build process.');

        this.defaults.push(...defaults);
    }

    /**
     * Streams all data from the database that has a lifetime
     *
     * @param {true} asStream If the data should be streamed
     * @returns {StructStream<T, Name>} 
     */
    getLifetimeItems(asStream: true): StructStream<T, Name>;
    /**
     * Returns all data from the database that has a lifetime
     *
     * @param {false} asStream If the data should be streamed
     * @returns {Promise<Result<StructData<T, Name>[], Error>>} 
     */
    getLifetimeItems(asStream: false): Promise<Result<StructData<T, Name>[], Error>>;
    /**
     * Streams/returns all data from the database that has a lifetime
     *
     * @param {boolean} asStream If the data should be streamed
     * @returns 
     */
    getLifetimeItems(asStream: boolean) {
        const get = () => this.database.select().from(this.table).where(sql`${this.table.lifetime} > 0`);
        if (asStream) {
            const stream = new StructStream(this);
            (async () => {
                const dataStream = await get();
                for (let i = 0; i < dataStream.length; i++) {
                    stream.add(this.Generator(dataStream[i] as any));
                }
                stream.end();
            })();
            return stream;
        } else {
            return attemptAsync(async () => {
                const data = await get();
                return data.map(d => this.Generator(d as any));
            });
        }
    }

    /**
     * Iterates over all data in the struct
     *
     * @param {(data: StructData<T, Name>, i: number) => void} fn 
     * @returns {void) => any} 
     */
    each(fn: (data: StructData<T, Name>, i: number) => void) {
        return this.all(true).pipe(fn);
    }

    /**
     * Builds the struct
     *
     * @param {PostgresJsDatabase} database The database to build the struct in
     * @param {?(event: RequestAction) => Promise<Response> | Response} [handler] The event handler for the struct (sveltekit)
     * @returns {any) => any} 
     */
    build(database: PostgresJsDatabase, handler?: (event: RequestAction) => Promise<Response> | Response) {
        if (this.built) throw new FatalStructError(`Struct ${this.name} has already been built`);
        if (this.data.sample) throw new FatalStructError(`Struct ${this.name} is a sample struct and should never be built`);
        return attemptAsync(async () => {
            this._database = database;

            resolveAll(await Promise.all(this.defaults.map(d => {
                return attemptAsync(async () => {
                    const exists = (await this.fromId(d.id)).unwrap();
                    if (exists) return;
                    if (!this.validate(d)) throw new FatalDataError('Invalid default data');
                    this.database.insert(this.table).values(d as any);
                });
            }))).unwrap();

            if (handler) {
                this.eventHandler(handler);
            }

            this.built = true;
        });
    }

    /**
     * Sveltekit event handler
     *
     * @private
     * @type {((event: RequestAction) => Promise<Response> | Response) | undefined}
     */
    private _eventHandler: ((event: RequestAction) => Promise<Response> | Response) | undefined;

    /**
     * Apply an event handler for sveltekit requests
     *
     * @param {(event: RequestAction) => Promise<Response> | Response} fn 
     */
    eventHandler(
        fn: (event: RequestAction) => Promise<Response> | Response
    ): void {
        this._eventHandler = fn;
    }

    /**
     * Uses zod to validate the data
     *
     * @param {unknown} data Data to validate
     * @param {?{ optionals?: string[]; not?: string[] }} [config] Configuration for the validation
     * @returns {boolean} 
     */
    validate(data: unknown, config?: { optionals?: string[]; not?: string[] }): boolean {
        if (data === null || Array.isArray(data) || typeof data !== 'object') return false;
    
        const keys = Object.keys(data);
        if (config?.not) {
            const keySet = new Set(keys);
            for (const n of config.not) {
                if (keySet.has(n)) return false;
            }
        }
    
        const createSchema = (type: any, key: string) =>
            config?.optionals?.includes(key) ? type.optional() : type;
    
        try {
            const schema = z
                .object({
                    id: createSchema(z.string(), 'id'),
                    created: createSchema(z.date().refine((d) => !isNaN(d.getTime()), { message: 'Invalid date' }), 'created'),
                    updated: createSchema(z.date().refine((d) => !isNaN(d.getTime()), { message: 'Invalid date' }), 'updated'),
                    archived: createSchema(z.boolean(), 'archived'),
                    universes: createSchema(z.string(), 'universes'),
                    attributes: createSchema(z.string(), 'attributes'),
                    lifetime: createSchema(z.number(), 'lifetime'),
                    ...Object.fromEntries(
                        Object.entries(this.data.structure).map(([k, v]) => {
                            const type = (v as any).config.dataType as ColumnDataType;
                            const schemaType = (() => {
                                switch (type) {
                                    case 'number': return z.number();
                                    case 'string': return z.string();
                                    case 'boolean': return z.boolean();
                                    case 'date': return z.date();
                                    default: throw new DataError(`Invalid data type: ${type} in ${k} of ${this.name}`);
                                }
                            })();
                            return [k, createSchema(schemaType, k)];
                        })
                    ),
                })
                .strict(); // Disallow additional keys
    
            schema.parse(data);
            return true;
        } catch (error) {
            if (error instanceof z.ZodError) {
                return false;
            }
            throw error; // Unexpected errors
        }
    }
    

    /**
     * Hashes the data in the struct
     *
     * @returns {*} 
     */
    hash() {
        return attemptAsync(async () => {
            const encoder = new TextEncoder();
            // const data = (await this.all(false)).unwrap()
            //     .sort((a, b) => a.id.localeCompare(b.id))
            //     .map(d => JSON.stringify(d.data))
            //     .join('');
            let data: string = '';
            const promises: Promise<void>[] = [];
            await this.all(true).pipe(async d => {
                const p = (async () => {
                    const buffer = encoder.encode(JSON.stringify(d.data));
                    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
                    const hashArray = Array.from(new Uint8Array(hashBuffer));
                    data += hashArray.map(b => b.toString(16).padStart(2, '0')).join(',');
                })();
                promises.push(p);
            });

            await Promise.all(promises);
            data = data.split(',').sort().join('');

            const buffer = encoder.encode(data);
            const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        });
    }

    /**
     * External API for the struct, used for querying data
     *
     * @private
     * @type {(Client | undefined)}
     */
    private _api: Client | undefined = undefined;

    /**
     * This will start the reflection process for the struct, allowing updates to be sent and received by the central server
     *
     * @param {(Server | Client)} api 
     * @returns {*} 
     */
    startReflection(api: Server | Client) {
        return attempt(() => {
            if (this.data.reflection && api instanceof Client) {
                // this property is only used for querying the data
                // Because of this, we don't need it for the central server
                this._api = api;
            }
            const em = api.getEmitter<T, Name>(this);

            em.on('archive', async ({ id, timestamp }) => {
                const data = await this.fromId(id);
                if (data.isErr()) return console.error(data.error);
                data.value?.setArchive(true, {
                    emit: false,
                });
            });
            em.on('restore', async ({ id, timestamp }) => {
                const data = await this.fromId(id);
                if (data.isErr()) return console.error(data.error);
                data.value?.setArchive(false, {
                    emit: false,
                });
            });
            em.on('delete', async ({ id, timestamp }) => {
                const data = await this.fromId(id);
                if (data.isErr()) return console.error(data.error);
                data.value?.delete({
                    emit: false,
                });
            });
            em.on('delete-version', async ({ id, timestamp, vhId }) => {
                const data = await this.fromId(id);
                if (data.isErr()) return console.error(data.error);
                if (!data) return;
                const versions = await data.value?.getVersions();
                if (!versions) return;
                if (versions.isErr()) return console.error(versions.error);
                const version = versions.value.find(v => v.vhId === vhId);
                version?.delete({
                    emit: false,
                });
            });
            em.on('restore-version', async ({ id, timestamp, vhId }) => {
                const data = await this.fromId(id);
                if (data.isErr()) return console.error(data.error);
                if (!data) return;
                const versions = await data.value?.getVersions();
                if (!versions) return;
                if (versions.isErr()) return console.error(versions.error);
                const version = versions.value.find(v => v.vhId === vhId);
                version?.restore({
                    emit: false,
                });
            });
            em.on('create', async ({ data, timestamp }) => {
                this.new(data, {
                    ignoreGlobals: false,
                    emit: false,
                });
            });
            em.on('update', async ({ data, timestamp }) => {
                const id = z.object({ id: z.string() }).parse(data).id;
                const d = await this.fromId(id);
                if (d.isErr()) return console.error(d.error);
                if (!d.value) {
                    this.new(
                        data,
                        {
                            ignoreGlobals: false,
                            emit: false,
                        }
                    );
                    return;
                }
                d.value.update(data, {
                    emit: false,
                });
            });
            // em.on('set-attributes', async ({ id, attributes, timestamp }) => {
            //     const data = await this.fromId(id);
            //     if (data.isErr()) return console.error(data.error);
            //     data.value?.setAttributes(attributes);
            // });
            // em.on('set-universes', async ({ id, universes, timestamp }) => {
            //     const data = await this.fromId(id);
            //     if (data.isErr()) return console.error(data.error);
            //     data.value?.setUniverses(universes);
            // });


            this.on('create', async d => {
                if (d.metadata.get('no-emit')) return;
                const res = await api.send(this, 'create', d.data);
                if (res.isErr()) d.delete({
                    emit: false,
                });
            });
            this.on('update', async d => {
                const prevState = d.metadata.get('prev-state'); // always read so it will delete
                if (d.metadata.get('no-emit')) return;
                const res = await api.send(this, 'update', d.data);
                if (res.isErr()) {
                    if (prevState) {
                        await d.update(JSON.parse(prevState as string), { emit: false });
                    }
                }
            });
            this.on('archive', async d => {
                if (d.metadata.get('no-emit')) return;
                const res = await api.send(this, 'archive', {
                    id: d.id,
                });

                if (res.isErr()) {
                    d.setArchive(false, {
                        emit: false,
                    });
                }
            });
            this.on('delete', async d => {
                if (d.metadata.get('no-emit')) return;
                const res = await api.send(this, 'delete', {
                    id: d.id,
                });
                if(res.isErr()) {
                    this.new(
                        d.safe(),
                        {
                            ignoreGlobals: false,
                            emit: false,
                        }
                    )
                }
            });
            this.on('delete-version', async d => {
                if (d.metadata.get('no-emit')) return;
                api.send(this, 'delete-version', {
                    id: d.id,
                    vhId: d.vhId,
                });
            });
            this.on('restore-version', async d => {
                if (d.metadata.get('no-emit')) return;
                api.send(this, 'restore-version', {
                    id: d.id,
                    vhId: d.vhId,
                });
            });
            this.on('restore', async d => {
                if (d.metadata.get('no-emit')) return;
                const res = await api.send(this, 'restore', {
                    id: d.id,
                });
                if (res.isErr()) {
                    d.setArchive(true, {
                        emit: false,
                    });
                }
            });
        });
    }

    // If the data is not found in the database, it will be added after the query to the server
    // I'm guessing this function will cause some overhead, but it's necessary for the reflection system
    // I don't know how to make it more efficient
    /**
     * Uses the API to query data. If the threshold is reached, it will query the main server for updates.
     *
     * @private
     * @template {keyof QueryType} K 
     * @param {K} type 
     * @param {QueryType[K]} data 
     * @returns {*} 
     */
    private apiQuery<K extends keyof QueryType>(type: K, data: QueryType[K]) {
        return attemptAsync(async () => {
            if (!this._api) throw new StructError('API not set');
            const lastRead = this._api.getLastRead(this.name, type);
            // Default to 1 hour
            if (lastRead === undefined || Date.now() - lastRead > (this.data.reflection?.queryThreshold ?? 1000 * 60 * 60)) {
                const result = (await this._api.query(this, type, data)).unwrap();
                if (result instanceof Stream) {
                    const updates: Promise<void>[] = [];
                    let timeout: NodeJS.Timeout;
                    let batch: Structable<T & typeof globalCols>[] = [];
                    let isProcessing = false;
    
                    const save = async () => {
                        if (isProcessing) return; // Prevent overlapping saves
                        isProcessing = true;
    
                        try {
                            await Promise.all(updates);
                            updates.length = 0;
    
                            const cache = [...batch];
                            batch = [];
                            for (const d of cache) {
                                try {
                                    const has = await this.fromId(d.id);
                                    if (has.isErr()) throw has.error;
    
                                    if (!has.value) {
                                        await this.new(d, { ignoreGlobals: false, emit: false });
                                    } else if (!has.value.isSimilar(d)) {
                                        await has.value.update(d, { emit: false });
                                    }
                                } catch (err) {
                                    console.error("Error processing item:", err);
                                }
                            }
                        } catch (err) {
                            console.error("Error in save():", err);
                        } finally {
                            isProcessing = false;
                        }
                    };
    
                    result.pipe(d => {
                        if (!d) return;
                        batch.push(d);
                        if (timeout) clearTimeout(timeout);
    
                        if (batch.length >= 100) {
                            updates.push(save());
                        } else {
                            timeout = setTimeout(() => {
                                updates.push(save());
                            }, 100);
                        }
                    });
                }
            }
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
        this.bypasses.push({ action, condition });
    }
}

/**
 * Interface for accounts, used for bypasses.
 *
 * @export
 * @interface Account
 * @typedef {Account}
 */
export interface Account {
    /**
     * Data for the account
     *
     * @type {{
     *         id: string;
     *         username: string;
     *         firstName: string;
     *         lastName: string;
     *         verified: boolean;
     *         email: string;
     *     }}
     */
    data: {
        id: string;
        username: string;
        firstName: string;
        lastName: string;
        verified: boolean;
        email: string;
    }

    /**
     * ID of the account
     *
     * @readonly
     * @type {string}
     */
    get id(): string;
}