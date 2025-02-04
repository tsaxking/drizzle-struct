/* eslint-disable @typescript-eslint/no-explicit-any */
import { attempt, attemptAsync } from "ts-utils/check";
import { EventEmitter } from "ts-utils/event-emitter";
import { match } from "ts-utils/match";
import { Stream } from "ts-utils/stream";
import { decode } from "ts-utils/text";
import { DataAction, PropertyAction } from './types';
import type { Readable, Writable } from "svelte/store";
import { type ColType } from "./types";
import { z } from "zod";

// TODO: Batching?

/**
 * Error if the data is an invalid state
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
 * Error if the struct is an invalid state
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
 * Error if the data is an invalid state, this should crash the application so use sparingly
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
 * Error if the struct is an invalid state, this should crash the application so use sparingly
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
 * Websocket/SSE connection to the server
 *
 * @export
 * @interface Socket
 * @typedef {Socket}
 */
export interface Socket {
    /**
     * Description placeholder
     *
     * @param {string} event 
     * @param {(data: unknown) => void} lisener 
     */
    on(event: string, lisener: (data: unknown) => void): void;
}


/**
 * Generates a type from a column type
 *
 * @export
 * @typedef {ColTsType}
 * @template {ColType} t 
 */
export type ColTsType<t extends ColType> = t extends 'string' ? string :
    t extends 'number' ? number :
    t extends 'boolean' ? boolean :
    t extends 'array' ? unknown[] :
    t extends 'json' ? unknown :
    t extends 'date' ? string :
    t extends 'bigint' ? bigint :
    t extends 'custom' ? unknown :
    t extends 'buffer' ? Buffer :
    never;

/**
 * Blank struct type
 *
 * @export
 * @typedef {Blank}
 */
export type Blank = Record<string, ColType>;

/**
 * Configuration for a struct
 *
 * @export
 * @typedef {StructBuilder}
 * @template {Blank} T 
 */
export type StructBuilder<T extends Blank> = {
    /**
     * Name of the struct, this is used to identify the struct between the front and back ends
     */
    name: string;
    /**
     * Structure of the struct, this is used to validate the data and typing
     */
    structure: T;
    /**
     * Websocket/SSE connection to the server, must be present if the struct is to be used
     */
    socket: Socket;
    /**
     * Log all actions to the console (only use for development because this could log sensitive data and may slow down the application)
     */
    log?: boolean;

    /**
     * Whether the struct is a browser struct, this is used to prevent fetch requests on the server when sveltekit is doing SSR
     */
    browser: boolean;
};

/**
 * Not all users may have full read access to data, so all properties will be optional
 *
 * @export
 * @typedef {PartialStructable}
 * @template {Blank} T 
 */
export type PartialStructable<T extends Blank> = {
    [K in keyof T]?: ColTsType<T[K]>;
}

/**
 * All users may have full read access to some data, so all properties will be required from this type
 *
 * @export
 * @typedef {Structable}
 * @template {Blank} T 
 */
export type Structable<T extends Blank> = {
    [K in keyof T]: ColTsType<T[K]>;
};

/**
 * General status message for all actions. Use this format when generating your eventHandler() on the back end
 *
 * @export
 * @typedef {StatusMessage}
 * @template [T=void] 
 */
export type StatusMessage<T = void> = {
    success: boolean;
    data?: T;
    message?: string;
}

/**
 * Version history of a data, requiring global columns and a version history id and created date
 *
 * @export
 * @typedef {VersionStructable}
 * @template {Blank} T 
 */
export type VersionStructable<T extends Blank> = Structable<{
    vhId: 'string';
    vhCreated: 'date';
}> & PartialStructable<T & GlobalCols>;

/**
 * Version history point of a data.
 *
 * @export
 * @class StructDataVersion
 * @typedef {StructDataVersion}
 * @template {Blank} T 
 */
export class StructDataVersion<T extends Blank> {
    /**
     * Creates an instance of StructDataVersion.
     *
     * @constructor
     * @param {Struct<T>} struct 
     * @param {PartialStructable<T & GlobalCols & {
     *         vhId: 'string';
     *         vhCreated: 'date';
     *     }>} data 
     */
    constructor(public readonly struct: Struct<T>, public readonly data: PartialStructable<T & GlobalCols & {
        vhId: 'string';
        vhCreated: 'date';
    }>) {}

    /**
     * unique version history id
     *
     * @readonly
     * @type {string}
     */
    get vhId() {
        return this.data.vhId;
    }

    /**
     * Id of the data this relates to
     *
     * @readonly
     * @type {string}
     */
    get id() {
        return this.data.id;
    }

    /**
     * Date the version was created
     *
     * @readonly
     * @type {Date}
     */
    get vhCreated() {   
        return this.data.vhCreated;
    }

    /**
     * Date the data was created
     *
     * @readonly
     * @type {string}
     */
    get created() {
        return this.data.created;
    }

    /**
     * Date the data was last updated
     *
     * @readonly
     * @type {string}
     */
    get updated() {
        return this.data.updated;
    }

    /**
     * Whether the data is archived
     *
     * @readonly
     * @type {boolean}
     */
    get archived() {
        return this.data.archived;
    }

    /**
     *  Lifespan of the data in milliseconds
     *
     * @readonly
     * @type {number}
     */
    get lifetime() {
        return this.data.lifetime;
    }

    /**
     * Delete the version
     *
     * @returns {*} 
     */
    delete() {
        return attemptAsync<StatusMessage>(async () => {
            return this.struct.post(DataAction.DeleteVersion, {
                id: this.data.id,
                vhId: this.data.vhId,
            }).then(r => r.unwrap().json());
        });
    }

    /**
     * Restore the version
     *
     * @returns {*} 
     */
    restore() {
        return attemptAsync<StatusMessage>(async () => {
            return this.struct.post(DataAction.RestoreVersion, {
                id: this.data.id,
                vhId: this.data.vhId,
            }).then(r => r.unwrap().json());
        });
    }
}


/**
 * Struct data for a single data point
 *
 * @export
 * @class StructData
 * @typedef {StructData}
 * @template {Blank} T 
 * @implements {Writable<PartialStructable<T & GlobalCols>>}
 */
export class StructData<T extends Blank> implements Writable< PartialStructable<T & GlobalCols>> {
    /**
     * Creates an instance of StructData.
     *
     * @constructor
     * @param {Struct<T>} struct 
     * @param {(PartialStructable<T & GlobalCols>)} data 
     */
    constructor(public readonly struct: Struct<T>, public data: PartialStructable<T> & PartialStructable<GlobalCols>) {}

    /**
     * Svelte store subscribers, used to automatically update the view
     *
     * @private
     * @type {*}
     */
    private subscribers = new Set<(value: PartialStructable<T & GlobalCols>) => void>();

    /**
     * Subscribe to the data
     *
     * @public
     * @param {(value:  PartialStructable<T & GlobalCols>) => void} fn 
     * @returns {() => void} 
     */
    public subscribe(fn: (value:  PartialStructable<T & GlobalCols>) => void): () => void {
        this.subscribers.add(fn);
        fn(this.data);
        return () => {
            this.subscribers.delete(fn);
        };
    }

    // this is what will set in the store
    /**
     * Sets the data and updates the subscribers, this will not update the backend
     *
     * @public
     * @param {(PartialStructable<T & GlobalCols>)} value 
     */
    public set(value: PartialStructable<T & GlobalCols>): void {
        this.data = value;
        this.subscribers.forEach((fn) => fn(value));
    }

    // this is what will send to the backend
    /**
     * Update the data in the backend, this will not update the subscribers as the backend will send the update back
     *
     * @public
     * @async
     * @param {(value: PartialStructable<T & GlobalCols>) => PartialStructable<T & {
     *         id: 'string';
     *     }>} fn 
     * @returns {(PartialStructable<T & { id: "string"; }>) => unknown)} 
     */
    public async update(fn: (value: PartialStructable<T & GlobalCols>) => PartialStructable<T & {
        id: 'string';
    }>) {
        return attemptAsync(async () => {
            const prev = { ...this.data };

            const result = fn(this.data);
            delete result.archived;
            delete result.created;
            delete result.updated;
            delete result.lifetime;
            delete result.universes;
            delete result.attributes;
            delete result.canUpdate;

            const res = (await this.struct.post(PropertyAction.Update, result)).unwrap();
            return {
                result: await res.json() as StatusMessage,
                undo: () => this.update(() => prev),
            }
        });
    }

    /**
     * Delete the data
     *
     * @returns {*} 
     */
    delete() {
        return attemptAsync<StatusMessage>(async () => {
            return this.struct.post(DataAction.Delete, {
                id: this.data.id,
            }).then(r => r.unwrap().json());
        });
    }

    /**
     * Archive or restore the data
     *
     * @param {boolean} archive 
     * @returns {*} 
     */
    setArchive(archive: boolean) {
        return attemptAsync<StatusMessage>(async () => {
            if (archive) {
                return this.struct.post(DataAction.Archive, {
                    id: this.data.id,
                }).then(r => r.unwrap().json());
            }
            return this.struct.post(DataAction.RestoreArchive, {
                id: this.data.id,
            }).then(r => r.unwrap().json());
        });
    }

    /**
     * Pull specific properties from the data, if the user does not have permission to read the property it will throw an error.
     * This is not wrapped in an attempt(() => {}), so you will need to handle errors yourself. This will return a svelte store.
     *
     * @template {keyof T} Key 
     * @param {...Key[]} keys 
     * @returns {*} 
     */
    pull<Key extends keyof T>(...keys: Key[]) {
        const o = {} as Structable<{
            [Property in Key]: T[Property];
        }>;

        for (const k of keys) {
            if (typeof this.data[k] === 'undefined') {
                return console.error(`User does not have permissions to read ${this.struct.data.name}.${k as string}`);
            }
            (o as any)[k] = this.data[k];
        }

        class PartialReadable implements Readable<typeof o> {
            constructor(public data: typeof o) {}

            public readonly subscribers = new Set<(data: typeof o) => void>();

            subscribe(fn: (data: typeof o) => void) {
                this.subscribers.add(fn);
                fn(o);
                return () => {
                    this.subscribers.delete(fn);
                    if (this.subscribers.size === 0) {
                        return u();
                    }
                };
            }
        }

        const w = new PartialReadable(o);

        const u = this.subscribe(d => {
            Object.assign(o, d);
        });

        return w;
    }

    // /**
    //  * Retrieves all universes the data is in
    //  *
    //  * @returns {*} 
    //  */
    // getUniverses() {
    //     return attempt(() => {
    //         const a = JSON.parse(this.data.universes);
    //         if (!Array.isArray(a)) throw new DataError('Universes must be an array');
    //         if (!a.every(i => typeof i === 'string')) throw new DataError('Universes must be an array of strings');
    //         return a;
    //     });
    // }
    // addUniverses(...universes: string[]) {}
    // removeUniverses(...universes: string[]) {}
    // setUniverses(...universes: string[]) {}

    /**
     * Retrieves all attributes the data has
     *
     * @returns {*} 
     */
    getAttributes() {
        return attempt(() => {
            const a = JSON.parse(this.data.attributes || '[]');
            if (!Array.isArray(a)) throw new DataError('Attributes must be an array');
            if (!a.every(i => typeof i === 'string')) throw new DataError('Attributes must be an array of strings');
            return a;
        });
    }
    // addAttributes(...attributes: string[]) {}
    // removeAttributes(...attributes: string[]) {}
    // setAttributes(...attributes: string[]) {}

    /**
     * Retrieves all versions of the data
     *
     * @returns {*} 
     */
    getVersions() {
        return attemptAsync(async () => {
            const versions = await this.struct.post(DataAction.ReadVersionHistory, {
                id: this.data.id
            }).then(r => r.unwrap().json()) as StatusMessage<VersionStructable<T>[]>;
        
            if (!versions.success) {
                throw new DataError(versions.message || 'Failed to get versions');
            }

            return versions.data?.map(v => new StructDataVersion(this.struct, v)) || [];
        });
    }
}

/**
 * Svelte store data array, used to store multiple data points and automatically update the view
 *
 * @export
 * @class DataArr
 * @typedef {DataArr}
 * @template {Blank} T 
 * @implements {Readable<StructData<T>[]>}
 */
export class DataArr<T extends Blank> implements Readable<StructData<T>[]> {
    /**
     * Creates an instance of DataArr.
     *
     * @constructor
     * @param {Struct<T>} struct 
     * @param {StructData<T>[]} data 
     */
    constructor(public readonly struct: Struct<T>, public data: StructData<T>[]) {}

    /**
     * All subscribers to the data array
     *
     * @private
     * @type {*}
     */
    private readonly subscribers = new Set<(value: StructData<T>[]) => void>();

    /**
     * Subscribe to the data array
     *
     * @public
     * @param {(value: StructData<T>[]) => void} fn 
     * @returns {() => void} 
     */
    public subscribe(fn: (value: StructData<T>[]) => void): () => void {
        this.subscribers.add(fn);
        fn(this.data);
        return () => {
            this.subscribers.delete(fn);
            if (this.subscribers.size === 0) {
                this._onAllUnsubscribe?.();
            }
        };
    }

    /**
     * Applies the new state to the data array and updates the subscribers
     *
     * @private
     * @param {StructData<T>[]} value 
     */
    private apply(value: StructData<T>[]): void {
        this.data = value.filter((v, i, a) => a.findIndex(_v => _v.data.id === v.data.id) === i);
        this.subscribers.forEach((fn) => fn(this.data));
        this.struct.log('Applied Data:', this.data);
    }

    /**
     * Adds data to the array and updates the subscribers
     *
     * @public
     * @param {...StructData<T>[]} values 
     */
    public add(...values: StructData<T>[]): void {
        this.apply([...this.data, ...values]);
    }

    /**
     *Removes data from the array and updates the subscribers
     *
     * @public
     * @param {...StructData<T>[]} values 
     */
    public remove(...values: StructData<T>[]): void {
        this.apply(this.data.filter((value) => !values.includes(value)));
    }

    /**
     * Runs when all subscribers have been removed
     *
     * @private
     * @type {(() => void) | undefined}
     */
    private _onAllUnsubscribe: (() => void) | undefined;
    /**
     * Add listener for when all subscribers have been removed
     *
     * @public
     * @param {() => void} fn 
     */
    public onAllUnsubscribe(fn: () => void): void {
        this._onAllUnsubscribe = fn;
    }
}

export class SingleWritable<T extends Blank> implements Writable<StructData<T>> {
    private data: StructData<T>;

    constructor(defaultData: StructData<T>) {
        this.data = defaultData;
    }
    private _onUnsubscribe?: () => void;
    private readonly subscribers = new Set<(data: StructData<T>) => void>();

    subscribe(fn: (data: StructData<T>) => void) {
        this.subscribers.add(fn);
        fn(this.data);
        return () => {
            this.subscribers.delete(fn);
            if (!this.subscribers.size) this._onUnsubscribe?.();
        };
    }

    onUnsubscribe(fn: () => void) {
        this._onUnsubscribe = fn;
    }

    set(data: StructData<T>) {
        this.data = data;
        this.subscribers.forEach(fn => fn(data));
    }

    update(fn: (data: StructData<T>) => StructData<T>) {
        this.set(fn(this.data));
    }

    get() {
        return this.data;
    }
}

/**
 * Stream of StructData
 *
 * @export
 * @class StructStream
 * @typedef {StructStream}
 * @template {Blank} T 
 * @extends {Stream<StructData<T>>}
 */
export class StructStream<T extends Blank> extends Stream<StructData<T>> {
    /**
     * Creates an instance of StructStream.
     *
     * @constructor
     * @param {Struct<T>} struct 
     */
    constructor(public readonly struct: Struct<T>) {
        super();
    }
}

/**
 * All events that can be received from the server
 *
 * @export
 * @typedef {StructEvents}
 * @template {Blank} T 
 */
export type StructEvents<T extends Blank> = {
    new: StructData<T>;
    update: StructData<T>;
    delete: StructData<T>;
    archive: StructData<T>;
    restore: StructData<T>;
};

/**
 * All read types that can be used to query data
 *
 * @typedef {ReadTypes}
 */
type ReadTypes = {
    all: void;
    archived: void;
    property: {
        key: string;
        value: unknown;
    };
    universe: string;
    custom: {
        query: string;
        data: unknown;
    }
}

/**
 * Global columns that are required for all data
 *
 * @typedef {GlobalCols}
 */
export type GlobalCols = {
    id: 'string';
    created: 'date';
    updated: 'date';
    archived: 'boolean';
    universe: 'string';
    // universes: 'string';
    attributes: 'string';
    lifetime: 'number';
    canUpdate: 'boolean';
}

/**
 * Struct class that communicates with the server
 *
 * @export
 * @class Struct
 * @typedef {Struct}
 * @template {Blank} T 
 */
export class Struct<T extends Blank> {
    public static readonly headers = new Map<string, string>();
    /**
     * All structs that are accessible
     *
     * @public
     * @static
     * @readonly
     * @type {*}
     */
    public static readonly structs = new Map<string, Struct<Blank>>();

    public static each(fn: (struct: Struct<Blank>) => void) {
        for (const struct of Struct.structs.values()) {
            fn(struct);
        }
    }

    public static buildAll() {
        Struct.each(s => s.build().then(res => res.isErr() && console.error(res.error)));
    }

    /**
     * Cached writables for automatic updating
     *
     * @private
     * @readonly
     * @type {*}
     */
    private readonly writables = new Map<string, DataArr<T>>();

    /**
     * Event emitter for all events
     *
     * @private
     * @readonly
     * @type {*}
     */
    private readonly emitter = new EventEmitter<StructEvents<T>>();

    /**
     * Listens to an event
     *
     * @public
     * @type {*}
     */
    public readonly on = this.emitter.on.bind(this.emitter);
    /**
     * Stops listening to an event
     *
     * @public
     * @type {*}
     */
    public readonly off = this.emitter.off.bind(this.emitter);
    /**
     * Listens to an event once
     *
     * @public
     * @type {*}
     */
    public readonly once = this.emitter.once.bind(this.emitter);
    /**
     * Emits an event
     *
     * @public
     * @type {*}
     */
    public readonly emit = this.emitter.emit.bind(this.emitter);

    /**
     * Cache of StructData, used for updates and optimziations
     *
     * @private
     * @readonly
     * @type {*}
     */
    private readonly cache = new Map<string, StructData<T>>();

    /**
     * Creates an instance of Struct.
     *
     * @constructor
     * @param {StructBuilder<T>} data 
     */
    constructor(public readonly data: StructBuilder<T>) {
        Struct.structs.set(data.name, this as any);


    }

    /**
     * Creates a new data point, if permitted
     *
     * @param {Structable<T>} data 
     * @returns {*} 
     */
    new(data: Structable<T>) {
        return attemptAsync<StatusMessage>(async () => {
            return this.post(DataAction.Create, data).then(r => r.unwrap().json()) ;
        });
    }

    /**
     * Sets listeners for the struct. Runs when the struct is built
     *
     * @private
     * @returns {*} 
     */
    private setListeners() {
        return attempt(() => {
            this.data.socket.on(`struct:${this.data.name}`, (data) => {
                this.log('Event Data:', data);
                if (typeof data !== 'object' || data === null) {
                    return console.error('Invalid data:', data);
                }
                if (!Object.hasOwn(data, 'event')) {
                    return console.error('Invalid event:', data);
                }
                if (!Object.hasOwn(data, 'data')) {
                    return console.error('Invalid data:', data);
                }
                const { event, data: structData } = data as { 
                    event: 'create' | 'update' | 'archive' | 'delete' | 'restore'; 
                    data:  PartialStructable<T & GlobalCols>; 
                };
                const { id } = structData;

                this.log('Event:', event);
                this.log('Data:', structData);

                if (!id) throw new Error('Data must have an id');
                
                match(event)
                    .case('archive', () => {
                        this.log('Archive:', structData);
                        const d = this.cache.get(id);
                        if (d) {
                            d.set({
                                ...d.data,
                                archived: true,
                            });
                            this.emit('archive', d);
                        }
                    })
                    .case('create', () => {
                        this.log('Create:', structData);
                        const exists = this.cache.get(id);
                        if (exists) return;
                        const d = new StructData(this, structData);
                        this.cache.set(id, d);
                        this.emit('new', d);
                    })
                    .case('delete', () => {
                        this.log('Delete:', structData);
                        const d = this.cache.get(id);
                        if (d) {
                            this.cache.delete(id);
                            this.log('Deleted:', d.data);
                            this.emit('delete', d);
                        }
                    })
                    .case('restore', () => {
                        this.log('Restore:', structData);
                        const d = this.cache.get(id);
                        if (d) {
                            d.set({
                                ...d.data,
                                archived: false,
                            });
                            this.emit('restore', d);
                        }
                    })
                    .case('update', () => {
                        this.log('Update:', structData);
                        const d = this.cache.get(id);
                        if (d) {
                            this.log('Data exists, updating');
                            d.set(structData);
                            this.emit('update', d);
                        } else {
                            this.log('Data does not exist, creating');
                            const d = new StructData(this, structData);
                            this.cache.set(id, d);
                            this.emit('new', d);
                        }
                    })
                    .default(() => console.error('Invalid event:', event))
                    .exec();
            });
        });
    }

    /**
     * Generates a new StructData or returns the cached version, if exists
     *
     * @param {(PartialStructable<T & GlobalCols>)} data 
     * @returns {StructData<T>} 
     */
    Generator(data: PartialStructable<T & GlobalCols>): StructData<T> {
        if (Object.hasOwn(data, 'id')) {
            const id = (data as { id: string; }).id;
            if (this.cache.has(id)) {
                return this.cache.get(id) as StructData<T>;
            }
        }

        // TODO: Data validation
        const d = new StructData(this, data);
        
        if (Object.hasOwn(data, 'id')) {
            this.cache.set(data.id as string, d);
        }

        return d;
    }

    /**
     * Validates the data
     *
     * @param {unknown} data 
     * @returns {(data is PartialStructable<T & GlobalCols>)} 
     */
    validate(data: unknown): data is PartialStructable<T & GlobalCols> {
        if (typeof data !== 'object' || data === null) return false;
        for (const key in data) {
            if (!Object.hasOwn(this.data.structure, key)) return false;
            const type = this.data.structure[key];
            const value = (data as any)[key];
            if (typeof value === 'undefined') continue; // likely does not have permission to read
            if (typeof value !== type) return false;
        }

        return true;
    }


    /**
     * Sends a post request to the server
     *
     * @param {(DataAction | PropertyAction)} action 
     * @param {unknown} data 
     * @returns {*} 
     */
    post(action: DataAction | PropertyAction | string, data: unknown) {
        return attemptAsync(async () => {
            if (!this.data.browser) throw new StructError('Currently not in a browser environment. Will not run a fetch request');
            const res = await fetch('/struct', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...Object.fromEntries(Struct.headers.entries())
                },
                body: JSON.stringify({
                    struct: this.data.name,
                    action,
                    data,
                }),
            });
            this.log('Post:', action, data, res);
            return res;
        });
    }

    /**
     * Builds the struct
     *
     * @returns {*} 
     */
    build() {
        return attemptAsync(async () => {
            this.log('Building struct:', this.data.name);
            const connect = (await this.connect()).unwrap();
            if (!connect.success) {
                this.log('Failed to connect to struct:', this.data.name);
                throw new FatalStructError(connect.message);
            }

            this.setListeners().unwrap();
        });
    }

    /**
     * Connects to the backend struct, confirming the front end and backend types are valid
     *
     * @returns {*} 
     */
    connect() {
        return attemptAsync<{
            success: boolean;
            message: string;
        }>(async () => {
            this.log('Connecting to struct:', this.data.name);
            const res = await fetch('/struct/connect', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    name: this.data.name,
                    structure: this.data.structure, 
                }),
            }).then(r => r.json());
            if (!res.success) {
                throw new FatalStructError(res.message);
            }
            return res;
        });
    }

    /**
     * Retrieves a stream of data from the server, used for querying data
     *
     * @private
     * @template {keyof ReadTypes} K 
     * @param {K} type 
     * @param {ReadTypes[K]} args 
     * @returns {StructStream<T>} 
     */
    public getStream<K extends keyof ReadTypes>(type: K, args: ReadTypes[K]): StructStream<T> {
        this.log('Stream:', type, args);
        const s = new StructStream(this);
        this.post(PropertyAction.Read, {
            type,
            args,
        }).then((res) => {
            this.log('Stream Result:', res);
            const reader = res.unwrap().body?.getReader();
            if (!reader) {
                return;
            }

            this.log('Stream Reader:', reader);

            let buffer = '';

            reader.read().then(({ done, value }) => {
                this.log('Stream Read:', done, value);
                const text = new TextDecoder().decode(value);
                let chunks = text.split('\n\n');
                this.log('Stream Chunks:', ...chunks);

                if (buffer) {
                    chunks[0] = buffer + chunks[0];
                    buffer = '';
                }

                if (!text.endsWith('\n\n')) {
                    buffer = chunks.pop() || '';
                }

                chunks = chunks.filter(i => {
                    if (i === 'end') done = true;
                    try {
                        JSON.parse(i);
                        return true;
                    } catch {
                        return false;
                    }
                });

                for (const chunk of chunks) {
                    try {
                        const data = JSON.parse(decode(chunk));
                        this.log('Stream Data:', data);
                        s.add(this.Generator(data));
                    } catch (error) {
                        console.error('Invalid JSON:', chunk);
                    }
                }

                if (done) {
                    this.log('Stream Done');
                    s.end();
                }
            });
        });
        return s;
    }

    /**
     * Gets all data as a stream
     *
     * @param {true} asStream If true, returns a stream
     * @returns {StructStream<T>} 
     */
    all(asStream: true): StructStream<T>;
    /**
     * Gets all data as an svelte store
     *
     * @param {false} asStream If false, returns a svelte store
     * @returns {DataArr<T>} 
     */
    all(asStream: false): DataArr<T>;
    /**
     * Gets all data as a stream or svelte store
     *
     * @param {boolean} asStream Returns a stream if true, svelte store if false
     * @returns 
     */
    all(asStream: boolean) {
        const getStream = () => this.getStream('all', undefined);
        if (asStream) return getStream();
        const arr = this.writables.get('all');
        if (arr) return arr;
        const newArr = new DataArr(this, []);
        this.writables.set('all', newArr);

        const add = (d: StructData<T>) => {
            newArr.add(d);
        }
        const remove = (d: StructData<T>) => {
            newArr.remove(d);
        }
        this.on('new', add);
        this.on('delete', remove);
        this.on('archive', remove);
        this.on('restore', add);

        getStream().pipe(add);
        newArr.onAllUnsubscribe(() => {
            this.off('new', add);
            this.off('delete', remove);
            this.off('archive', remove);
            this.off('restore', add);
            this.writables.delete('all');
        });
        return newArr;
    }

    /**
     * Gets all archived data
     *
     * @param {true} asStream If true, returns a stream
     * @returns {StructStream<T>} 
     */
    archived(asStream: true): StructStream<T>;
    /**
     * Gets all archived data
     *
     * @param {false} asStream If false, returns a svelte store
     * @returns {DataArr<T>} 
     */
    archived(asStream: false): DataArr<T>;
    /**
     * Gets all archived data
     *
     * @param {boolean} asStream Returns a stream if true, svelte store if false
     * @returns 
     */
    archived(asStream: boolean) {
        const getStream = () => this.getStream('archived', undefined);
        if (asStream) return getStream();
        const arr = this.writables.get('archived');
        if (arr) return arr;
        const newArr = new DataArr(this, []);
        this.writables.set('archived', newArr);

        const add = (d: StructData<T>) => {
            newArr.add(d);
        }
        const remove = (d: StructData<T>) => {
            newArr.remove(d);
        }
        this.on('delete', remove);
        this.on('archive', add);
        this.on('restore', remove);

        getStream().pipe(add);

        newArr.onAllUnsubscribe(() => {
            this.off('delete', remove);
            this.off('archive', add);
            this.off('restore', remove);
            this.writables.delete('archived');
        });

        return newArr;
    }

    /**
     * Gets all data with a specific property value
     *
     * @param {string} key Property key
     * @param {unknown} value Property value
     * @param {true} asStream If true, returns a stream
     * @returns {StructStream<T>} 
     */
    fromProperty<K extends keyof (T & GlobalCols)>(key: K, value: ColTsType<(T & GlobalCols)[K]>, asStream: true): StructStream<T>;
    /**
     * Gets all data with a specific property value
     *
     * @param {string} key Property key
     * @param {unknown} value Property value
     * @param {false} asStream If false, returns a svelte store
     * @returns {DataArr<T>} 
     */
    fromProperty<K extends keyof (T & GlobalCols)>(key: K, value: ColTsType<(T & GlobalCols)[K]>, asStream: false): DataArr<T>;
    /**
     * Gets all data with a specific property value
     *
     * @param {string} key Property key
     * @param {unknown} value Property value
     * @param {boolean} asStream Returns a stream if true, svelte store if false
     * @returns 
     */
    fromProperty<K extends keyof (T & GlobalCols)>(key: K, value: ColTsType<(T & GlobalCols)[K]>, asStream: boolean) {
        const s = this.getStream('property', { key: String(key), value });
        if (asStream) return s;
        const arr = this.writables.get(`property:${String(key)}:${JSON.stringify(value)}`) || new DataArr(this, []);
        this.writables.set(`property:${String(key)}:${JSON.stringify(value)}`, arr);

        const add = (d: StructData<T>) => {
            if ((d.data as any)[key] === value) arr.add(d);
        }
        const remove = (d: StructData<T>) => {
            arr.remove(d);
        }
        const update = (d: StructData<T>) => {
            if ((d.data as any)[key] === value && !arr.data.includes(d)) {
                arr.add(d);
            } else if ((d.data as any)[key] !== value) {
                arr.remove(d);
            }
        };

        this.on('new', add);
        this.on('archive', remove);
        this.on('restore', add);
        this.on('delete', remove);
        this.on('update', update);

        s.pipe((d) => {
            arr.add(d);
        });

        arr.onAllUnsubscribe(() => {
            this.off('new', add);
            this.off('archive', remove);
            this.off('restore', add);
            this.off('delete', remove);
            this.off('update', update);
            this.writables.delete(`property:${String(key)}:${JSON.stringify(value)}`);
        });
        return arr;
    }

    /**
     * Gets all data in a specific universe
     *
     * @param {string} universe Universe id
     * @param {true} asStream If true, returns a stream
     * @returns {StructStream<T>} 
     */
    fromUniverse(universe: string, asStream: true): StructStream<T>;
    /**
     * Gets all data in a specific universe
     *
     * @param {string} universe Universe id
     * @param {false} asStream If false, returns a svelte store
     * @returns {DataArr<T>} 
     */
    fromUniverse(universe: string, asStream: false): DataArr<T>;
    /**
     * Gets all data in a specific universe
     *
     * @param {string} universe Universe id
     * @param {boolean} asStream Returns a stream if true, svelte store if false
     * @returns 
     */
    fromUniverse(universe: string, asStream: boolean) {
        const s = this.getStream('universe', universe);
        if (asStream) return s;
        const arr = this.writables.get(`universe:${universe}`) || new DataArr(this, []);
        this.writables.set(`universe:${universe}`, arr);

        const add = (d: StructData<T>) => {
            // TODO: Check if this data is in the universe
            arr.add(d);
        }

        const remove = (d: StructData<T>) => {
            arr.remove(d);
        }

        this.on('new', add);
        this.on('archive', remove);
        this.on('restore', add);
        this.on('delete', remove);


        s.pipe((d) => {
            arr.add(d);
        });

        arr.onAllUnsubscribe(() => {
            this.off('new', add);
            this.off('archive', remove);
            this.off('restore', add);
            this.off('delete', remove);
            this.writables.delete(`universe:${universe}`);
        });
        return arr;
    }

    /**
     * Gets data from a specific id
     *
     * @param {string} id  Id of the data
     * @returns {*} 
     */
    fromId(id: string) {
        return attemptAsync(async () => {
            const has = this.cache.get(id);
            if (has) return has;
            const res = await this.post(PropertyAction.Read, { type: 'id', data: id });
            const data = await res.unwrap().json();
            return this.Generator(data);
        });
    }


    /**
     * Logs to the console
     *
     * @private
     * @param {...any[]} args 
     */
    public log(...args: any[]) {
        if (this.data.log) {
            console.log(`[${this.data.name}]`, ...args);
        }
    }

    query(query: string, data: unknown, config: {
        asStream: true;
    }): StructStream<T>;
    query(query: string, data: unknown, config: {
        asStream: false;
        satisfies: (data: StructData<T>) => boolean;
        includeArchive?: boolean; // default is falsy
    }): DataArr<T>;
    query(query: string, data: unknown, config: {
        asStream: boolean;
        satisfies?: (data: StructData<T>) => boolean;
        includeArchive?: boolean;
    }) {
        const get = () => {
            return this.getStream('custom', {
                query,
                data,
            });
        }
        if (config.asStream) return get();
        const exists = this.writables.get(`custom:${query}:${JSON.stringify(data)}`);
        if (exists) return exists;

        const arr = new DataArr(this, []);

        const res = get();

        const add = (d: StructData<T>) => {
            if (config.satisfies?.(d)) {
                arr.add(d);
            }
        };

        const remove = (d: StructData<T>) => {
            if (config.satisfies?.(d)) {
                arr.remove(d);
            }
        };

        this.on('new', add);
        if (!config.includeArchive) this.on('restore', add);
        this.on('archive', remove);
        if (!config.includeArchive) this.on('delete', remove);

        res.pipe(d => arr.add(d));

        arr.onAllUnsubscribe(() => {
            this.writables.delete(`custom:${query}:${JSON.stringify(data)}`);

            this.off('new', add);
            this.off('restore', add);
            this.off('archive', remove);
            this.off('delete', remove);
        });

        return arr;
    }

    send<T>(name: string, data: unknown, returnType: z.ZodType<T>) {
        return attemptAsync<T>(async () => {
            const res = await this.post('retrieve', {
                type: 'retrieve',
                args: {
                    name,
                    data,
                }
            })
                .then(r => r.unwrap().json());
            return returnType.parse(res);
        });
    }

    // custom functions
    call(event: string, data: unknown) {
        return attemptAsync(async () => {
            const res = await (await this.post('custom', {
                event,
                data,
            })).unwrap().json();
            
            return z.object({
                success: z.boolean(),
                message: z.string().optional(),
                data: z.unknown().optional(),
            }).parse(res);
        });
    }
};