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
import { Client, Server } from './reflection';

export class StructError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'StructError';
    }
}

export class FatalStructError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FatalStructError';
    }
}

export class DataError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DataError';
    }
}

export class FatalDataError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FatalDataError';
    }
}

export type Blank = Record<string, PgColumnBuilderBase>;

export type StructBuilder<T extends Blank, Name extends string> = {
    name: Name;
    structure: T;
    sample?: boolean;
    loop?: {
        fn: (data: StructData<T, Name>, index: number) => void;
        time: number;
    }
    frontend?: boolean;
    defaultUniverses?: string[];
    generators?: Partial<{
        id: () => string;
        attributes: () => string[];
        lifetime: () => number;
    }>;
    versionHistory?: {
        type: 'days' | 'versions';
        amount: number;
    };
    universeLimit?: number;
    // This is so the struct isn't actually permanently in the database, it 'reflects' a different server's data
    // If there are merge conflicts, it will always prioritize the other server's data
    // It will still save in the local database for optimization purposes
    // If there are type conflicts, they are incompatible, so it will throw an error
    reflect?: {
        address: string;
        port: number;
        key: string;
        // How often it should sync with the other server
        // it will first send a hash of the data, and if the other server doesn't have that hash, the other server will pipe the data
        interval: number;
    };
};


export type Data<T extends Struct<Blank, string>> = T['sample'];


export const globalCols = {
    id: text('id').primaryKey(),
    created: timestamp<'created', 'string'>('created').notNull(),
    updated: timestamp<'updated', 'string'>('updated').notNull(),
    archived: boolean<'archived'>('archived').default(false).notNull(),
    universes: text('universes').notNull(),
    attributes: text('attributes').notNull(),
    lifetime: integer('lifetime').notNull(),
};

export type Table<T extends Blank, TableName extends string> = PgTableWithColumns<{
    name: TableName;
    schema: undefined;
    columns: BuildColumns<TableName, T, 'pg'>;
    dialect: "pg";
}>;

export type Structable<T extends Blank> = {
    [K in keyof T]: TsType<T[K]['_']['dataType']>;// | TsType<T[K]['config']['dataType']>;
}

export class StructStream<T extends Blank = Blank, Name extends string = string> extends Stream<StructData<T, Name>> {
    constructor(public readonly struct: Struct<T, Name>) {
        super();
    }
}

export const versionGlobalCols = {
    vhId: text('vh_id').primaryKey(),
    id: text('id').notNull(), // Used to overwrite the other primary key
    vhCreated: timestamp<'vh_created', 'string'>('vh_created').notNull(),
};

export class DataVersion<T extends Blank, Name extends string> {
    constructor(public readonly struct: Struct<T, Name>, public readonly data: Structable<T & typeof globalCols & typeof versionGlobalCols>) {}

    get vhId() {
        return this.data.vhId;
    }

    get id() {
        return this.data.id;
    }

    get created() {
        return new Date(this.data.created);
    }

    get updated() {
        return new Date(this.data.updated);
    }

    get archived() {
        return this.data.archived;
    }

    get vhCreated() {
        return new Date(this.data.vhCreated);
    }

    get database() {
        return this.struct.database;
    }

    delete(config?: {
        emit?: boolean;
    }) {
        return attemptAsync(async () => {
            if (!this.struct.versionTable) throw new StructError(`Struct ${this.struct.name} does not have a version table`);
            await this.database.delete(this.struct.versionTable).where(sql`${this.struct.versionTable.vhId} = ${this.vhId}`);
            if (config?.emit || config?.emit === undefined) this.struct.emit('delete-version', this);
        });
    }

    restore(config?: {
        emit?: boolean;
    }) {
        return attemptAsync(async () => {
            const data = (await this.struct.fromId(this.id)).unwrap();
            if (!data) this.struct.new(this.data);
            else await data.update(this.data);
            if (config?.emit || config?.emit === undefined) this.struct.emit('restore-version', this);
        });
    }
}

export class StructData<T extends Blank = any, Name extends string = any> {
    constructor(public readonly data: Readonly<Structable<T & typeof globalCols>>, public readonly struct: Struct<T, Name>) {}

    get id() {
        return this.data.id;
    }

    get created() {
        return new Date(this.data.created);
    }

    get updated() {
        return new Date(this.data.updated);
    }

    get archived() {
        return this.data.archived;
    }

    get database() {
        return this.struct.database;
    }

    get lifetime() {
        return this.data.lifetime;
    }

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

            if (config?.emit || config?.emit === undefined) this.struct.eventEmitter.emit('update', this);
        });
    }

    setArchive(archived: boolean, config?: {
        emit?: boolean;
    }) {
        return attemptAsync(async () => {
            await this.struct.database.update(this.struct.table).set({
                archived,
                updated: new Date(),
            } as any).where(sql`${this.struct.table.id} = ${this.id}`);

            if (config?.emit || config?.emit === undefined) this.struct.eventEmitter.emit(archived ? 'archive' : 'restore', this);
        });
    }

    delete(config?: {
        emit?: boolean;
    }) {
        return attemptAsync(async () => {
            this.makeVersion();
            await this.database.delete(this.struct.table).where(sql`${this.struct.table.id} = ${this.id}`);
            if (config?.emit || config?.emit === undefined) this.struct.eventEmitter.emit('delete', this);
        });
    }


    // TODO: events for make version
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

    getVersions() {
        return attemptAsync(async () => {
            if (!this.struct.versionTable) throw new StructError(`Struct ${this.struct.name} does not have a version table`);
            const data = await this.database.select().from(this.struct.versionTable).where(sql`${this.struct.versionTable.id} = ${this.id}`);
            return data.map(d => new DataVersion(this.struct, d as any));
        });
    }

    // TODO: events for attributes and universes
    getAttributes() {
        return attempt(() => {
            const a = JSON.parse(this.data.attributes);
            if (!Array.isArray(a)) throw new DataError('Attributes must be an array');
            if (!a.every(i => typeof i === 'string')) throw new DataError('Attributes must be an array of strings');
            return a;
        });
    }
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
    removeAttributes(...attributes: string[]) {
        return attemptAsync(async () => {
            const a = this.getAttributes().unwrap();
            const newAttributes = a.filter(i => !attributes.includes(i));
            return (await this.setAttributes(newAttributes)).unwrap();
        });
    }
    addAttributes(...attributes: string[]) {
        return attemptAsync(async () => {
            const a = this.getAttributes().unwrap();
            return (await this.setAttributes([...a, ...attributes])).unwrap()
        });
    }

    getUniverses() {
        return attempt(() => {
            const a = JSON.parse(this.data.universes);
            if (!Array.isArray(a)) throw new DataError('Universes must be an array');
            if (!a.every(i => typeof i === 'string')) throw new DataError('Universes must be an array of strings');
            return a;
        });
    }
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
    removeUniverses(...universes: string[]) {
        return attemptAsync(async () => {
            const a = this.getUniverses().unwrap();
            const newUniverses = a.filter(i => !universes.includes(i));
            return (await this.setUniverses(newUniverses)).unwrap()
        });
    }
    addUniverses(...universes: string[]) {
        return attemptAsync(async () => {
            const a = this.getUniverses().unwrap();
            return (await this.setUniverses([...a, ...universes])).unwrap()
        });
    }

    safe(omit?: (keyof T & keyof typeof globalCols)[]) {
        const data = { ...this.data };
        if (omit) {
            for (const key of omit) {
                delete data[key];
            }
        }
        return data;
    }
}

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

export interface RequestEvent {
    request: Request;
    cookies: any;
}

export type RequestAction = {
    action: DataAction | PropertyAction;
    data: unknown;
    request: RequestEvent;
    struct: Struct;
};

export type TsType<T extends ColumnDataType> = T extends 'string' ? string : T extends 'number' ? number : T extends 'boolean' ? boolean : T extends 'timestamp' ? Date : never;

export class Struct<T extends Blank = any, Name extends string = any> {
    public static async buildAll(database: PostgresJsDatabase, handler?: (event: RequestAction) => Promise<Response> | Response) {
        return resolveAll(await Promise.all([...Struct.structs.values()].map(s => s.build(database, handler))));
    }

    public static readonly structs = new Map<string, Struct<Blank, string>>();

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
    };

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

    public static each(fn: (struct: Struct<Blank, string>) => void) {
        for (const s of Struct.structs.values()) {
            fn(s);
        }
    }
    
    public readonly table: Table<T & typeof globalCols, Name>;
    public readonly versionTable?: Table<T & typeof globalCols & typeof versionGlobalCols, `${Name}_history`>;
    public readonly eventEmitter = new EventEmitter<StructEvents<T, Name>>();

    public readonly on = this.eventEmitter.on.bind(this.eventEmitter);
    public readonly once = this.eventEmitter.once.bind(this.eventEmitter);
    public readonly off = this.eventEmitter.off.bind(this.eventEmitter);
    public readonly emit = this.eventEmitter.emit.bind(this.eventEmitter);

    public loop?: Loop;
    public built = false;

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

    private _database?: PostgresJsDatabase;

    get database(): PostgresJsDatabase {
        if (!this._database) throw new FatalStructError('Struct database not set');
        return this._database;
    }

    get name() {
        return this.data.name;
    }

    get sample(): StructData<T, Name> {
        throw new Error('Struct.sample should never be called at runtime, it is only used for testing');
    }

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
                universes: '',
                attributes: JSON.stringify(this.data.generators?.attributes?.() ?? []),
                lifetime: this.data.generators?.lifetime?.() || 0,
            }
            const newData: Structable<T & typeof globalCols> = {
                ...data,
                ...(!config?.ignoreGlobals ? globals : {}),
            };

            await this.database.insert(this.table).values(newData as any);

            const d = this.Generator(newData);
            if (config?.emit || config?.emit === undefined) this.eventEmitter.emit('create', d);

            return d;
        });
    }

    Generator(data: Structable<T & typeof globalCols>) {
        return new StructData(data, this);
    }

    fromId(id: string) {
        return attemptAsync(async () => {
            const data = await this.database.select().from(this.table).where(sql`${this.table.id} = ${id}`);
            const a = data[0];
            if (!a) return undefined;
            return this.Generator(a as any);
        });
    }

    fromIds(ids: string[], asStream: true): StructStream<T, Name>;
    fromIds(ids: string[], asStream: false): Promise<Result<StructData<T, Name>[], Error>>;
    fromIds(ids: string[], asStream: boolean) {
        const get = () => this.database.select().from(this.table).where(sql`${this.table.id} IN (${ids})`);
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
    all(asStream: true, includeArchived?: boolean): StructStream<T, Name>;
    all(asStream: false, includeArchived?: boolean): Promise<Result<StructData<T, Name>[], Error>>;
    all(asStream: boolean, includeArchived = false){
        const get = () => this.database.select().from(this.table).where(sql`${this.table.archived} = ${includeArchived}`);
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

    archived(asStream: true): StructStream<T, Name>;
    archived(asStream: false): Promise<Result<StructData<T, Name>[], Error>>;
    archived(asStream: boolean) {
        const get = () => this.database.select().from(this.table).where(sql`${this.table.archived} = ${true}`);
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

    fromProperty<K extends keyof T>(key: K, value: TsType<T[K]['_']['dataType']>, asStream: true): StructStream<T, Name>;
    fromProperty<K extends keyof T>(key: K, value: TsType<T[K]['_']['dataType']>, asStream: false): Promise<Result<StructData<T, Name>[], Error>>;
    fromProperty<K extends keyof T>(key: K, value: TsType<T[K]['_']['dataType']>, asStream: boolean) {
        const get = () => this.database.select().from(this.table).where(sql`${this.table[key] as any} = ${value} AND ${this.table.archived} = ${false}`);
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
    };

    fromUniverse(universe: string, asStream: true): StructStream<T, Name>;
    fromUniverse(universe: string, asStream: false): Promise<Result<StructData<T, Name>[], Error>>;
    fromUniverse(universe: string, asStream: boolean) {
        const get = () => this.database.select().from(this.table).where(sql`${this.table.universes} LIKE ${`%${universe}%`} AND ${this.table.archived} = ${false}`);
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
    };

    clear() {
        return attemptAsync(async () => {});
    }

    private readonly defaults: Structable<T & typeof globalCols>[] = [];

    addDefaults(...defaults: Structable<T & typeof globalCols>[]) {
        if (this.built) throw new FatalStructError('Cannot add defaults after struct has been built. Those are applied during the build process.');

        this.defaults.push(...defaults);
    }

    getLifetimeItems(asStream: true): StructStream<T, Name>;
    getLifetimeItems(asStream: false): Promise<Result<StructData<T, Name>[], Error>>;
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

    each(fn: (data: StructData<T, Name>, i: number) => void) {
        return this.all(true).pipe(fn);
    }

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

    private _eventHandler: ((event: RequestAction) => Promise<Response> | Response) | undefined;

    eventHandler(
        fn: (event: RequestAction) => Promise<Response> | Response
    ): void {
        this._eventHandler = fn;
    }

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
    

    hash() {
        return attemptAsync(async () => {
            const data = (await this.all(false)).unwrap()
                .sort((a, b) => a.id.localeCompare(b.id))
                .map(d => JSON.stringify(d.data))
                .join('');

            const encoder = new TextEncoder();
            const buffer = encoder.encode(data);
            const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        });
    }

    startReflection(server: Server | Client) {
        return attempt(() => {
            const em = server.getEmitter(this);
        });
    }

    public readonly bypasses: {
        action: DataAction | PropertyAction | '*';
        condition: (account: Account, data?: any) => boolean;
    }[] = [];

    bypass<Action extends DataAction | PropertyAction | '*'>(
        action: Action,
        condition: (account: Account, data?: Structable<T & typeof globalCols>) => boolean
    ) {
        this.bypasses.push({ action, condition });
    }
}

export interface Account {
    data: {
        id: string;
        username: string;
        firstName: string;
        lastName: string;
        verified: boolean;
        email: string;
    }

    get id(): string;
}