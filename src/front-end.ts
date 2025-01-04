/* eslint-disable @typescript-eslint/no-explicit-any */
import { attempt, attemptAsync } from "ts-utils/check";
import { EventEmitter } from "ts-utils/event-emitter";
import { match } from "ts-utils/match";
import { Stream } from "ts-utils/stream";
import { decode } from "ts-utils/text";
import { DataAction, PropertyAction } from './types';
import type { Readable, Writable } from "svelte/store";
import { type ColType } from "./types";

// TODO: Batching?

export class DataError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DataError';
    }
}

export class StructError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'StructError';
    }
}

export class FatalDataError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FatalDataError';
    }
}

export class FatalStructError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FatalStructError';
    }
}

export interface Socket {
    on(event: string, lisener: (data: unknown) => void): void;
}


export type ColTsType<t extends ColType> = t extends 'string' ? string :
    t extends 'number' ? number :
    t extends 'boolean' ? boolean :
    t extends 'array' ? unknown[] :
    t extends 'json' ? unknown :
    t extends 'date' ? Date :
    t extends 'bigint' ? bigint :
    t extends 'custom' ? unknown :
    t extends 'buffer' ? Buffer :
    never;

export type Blank = Record<string, ColType>;

export type StructBuilder<T extends Blank> = {
    name: string;
    structure: T;
    socket: Socket;
    log?: boolean;
};

export type PartialStructable<T extends Blank> = {
    [K in keyof T]?: ColTsType<T[K]>;
}

export type Structable<T extends Blank> = {
    [K in keyof T]: ColTsType<T[K]>;
};

export type StatusMessage<T = void> = {
    success: boolean;
    data?: T;
    message?: string;
}


export class StructData<T extends Blank> implements Writable< PartialStructable<T> & Structable<GlobalCols>> {
    constructor(public readonly struct: Struct<T>, public data: PartialStructable<T> & Structable<GlobalCols>) {}

    private subscribers = new Set<(value: PartialStructable<T> & Structable<GlobalCols>) => void>();

    public subscribe(fn: (value:  PartialStructable<T> & Structable<GlobalCols>) => void): () => void {
        this.subscribers.add(fn);
        fn(this.data);
        return () => {
            this.subscribers.delete(fn);
        };
    }

    // this is what will set in the store
    public set(value: PartialStructable<T> & Structable<GlobalCols>): void {
        this.data = value;
        this.subscribers.forEach((fn) => fn(value));
    }

    // this is what will send to the backend
    public async update(fn: (value: PartialStructable<T> & Structable<GlobalCols>) => PartialStructable<T> & Structable<{
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

            const res = (await this.struct.post(PropertyAction.Update, result)).unwrap();
            return {
                result: await res.json() as StatusMessage,
                undo: () => this.update(() => prev),
            }
        });
    }

    delete() {
        return attemptAsync<StatusMessage>(async () => {
            return this.struct.post(DataAction.Delete, {
                id: this.data.id,
            }).then(r => r.unwrap().json());
        });
    }

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

    // getVersionHistory() {}

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
                fn(this.data);
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

    getUniverses() {
        return attempt(() => {
            const a = JSON.parse(this.data.universes);
            if (!Array.isArray(a)) throw new DataError('Universes must be an array');
            if (!a.every(i => typeof i === 'string')) throw new DataError('Universes must be an array of strings');
            return a;
        });
    }
    // addUniverses(...universes: string[]) {}
    // removeUniverses(...universes: string[]) {}
    // setUniverses(...universes: string[]) {}

    getAttributes() {
        return attempt(() => {
            const a = JSON.parse(this.data.attributes);
            if (!Array.isArray(a)) throw new DataError('Attributes must be an array');
            if (!a.every(i => typeof i === 'string')) throw new DataError('Attributes must be an array of strings');
            return a;
        });
    }
    // addAttributes(...attributes: string[]) {}
    // removeAttributes(...attributes: string[]) {}
    // setAttributes(...attributes: string[]) {}
}

export class DataArr<T extends Blank> implements Readable<StructData<T>[]> {
    constructor(public readonly struct: Struct<T>, public data: StructData<T>[]) {}

    private subscribers = new Set<(value: StructData<T>[]) => void>();

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

    private apply(value: StructData<T>[]): void {
        this.data = value.filter((v, i, a) => a.indexOf(v) === i);
        this.subscribers.forEach((fn) => fn(value));
    }

    // public update(fn: (value: StructData<T>[]) => StructData<T>[]): void {
    //     this.set(fn(this.data));
    // }

    public add(...values: StructData<T>[]): void {
        this.apply([...this.data, ...values]);
    }

    public remove(...values: StructData<T>[]): void {
        this.apply(this.data.filter((value) => !values.includes(value)));
    }

    private _onAllUnsubscribe: (() => void) | undefined;
    public onAllUnsubscribe(fn: () => void): void {
        this._onAllUnsubscribe = fn;
    }
}

export class StructStream<T extends Blank> extends Stream<StructData<T>> {
    constructor(public readonly struct: Struct<T>) {
        super();
    }
}

export type StructEvents<T extends Blank> = {
    new: StructData<T>;
    update: StructData<T>;
    delete: StructData<T>;
    archive: StructData<T>;
    restore: StructData<T>;
};

type ReadTypes = {
    all: void;
    archived: void;
    property: {
        key: string;
        value: unknown;
    };
    universe: string;
}

type GlobalCols = {
    id: 'string';
    created: 'string';
    updated: 'string';
    archived: 'boolean';
    universes: 'string';
    attributes: 'string';
    lifetime: 'number';
}

export class Struct<T extends Blank> {
    public static route = '/api';

    public static readonly structs = new Map<string, Struct<Blank>>();

    private readonly writables = new Map<string, DataArr<T>>();

    private readonly emitter = new EventEmitter<StructEvents<T>>();

    public on = this.emitter.on.bind(this.emitter);
    public off = this.emitter.off.bind(this.emitter);
    public once = this.emitter.once.bind(this.emitter);
    public emit = this.emitter.emit.bind(this.emitter);

    private readonly cache = new Map<string, StructData<T>>();

    constructor(public readonly data: StructBuilder<T>) {
        Struct.structs.set(data.name, this as any);


    }

    new(data: Structable<T>) {
        return attemptAsync<StatusMessage>(async () => {
            return this.post(DataAction.Create, data).then(r => r.unwrap().json()) ;
        });
    }

    private setListeners() {
        return attempt(() => {
            this.data.socket.on(`struct:${this.data.name}`, (data) => {
                this.log('Data:', data);
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
                    data:  PartialStructable<T> & Structable<GlobalCols>; 
                };
                const { id } = structData;

                this.log('Event:', event);
                this.log('Data:', structData);
                
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
                            d.set(structData);
                            this.emit('update', d);
                        }
                    })
                    .default(() => console.error('Invalid event:', event))
                    .exec();
            });
        });
    }

    Generator(data: PartialStructable<T> & Structable<GlobalCols>): StructData<T> {
        // TODO: Data validation
        const d = new StructData(this, data);
        
        if (Object.hasOwn(data, 'id')) {
            this.cache.set(data.id as string, d);
        }

        return d;
    }

    validate(data: unknown): data is PartialStructable<T> & Structable<GlobalCols> {
        if (typeof data !== 'object' || data === null) return false;
        for (const key in data) {
            if (!Object.hasOwn(this.data.structure, key)) return false;
            const type = this.data.structure[key];
            const value = (data as any)[key];
            if (typeof value !== type) return false;
        }

        return true;
    }


    post(action: DataAction | PropertyAction, data: unknown) {
        return attemptAsync(async () => {
            const res = await fetch('/struct', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
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

    build() {
        return attemptAsync(async () => {
            this.log('Building struct:', this.data.name);
            const connect = (await this.connect()).unwrap();
            if (!connect.success) {
                throw new FatalStructError(connect.message);
            }

            this.setListeners().unwrap();
        });
    }

    connect() {
        return attemptAsync<{
            success: boolean;
            message: string;
        }>(async () => {
            this.log('Connecting to struct:', this.data.name);
            return fetch('/struct/connect', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    name: this.data.name,
                    structure: this.data.structure, 
                }),
            }).then(r => r.json());
        });
    }

    private getStream<K extends keyof ReadTypes>(type: K, args: ReadTypes[K]): StructStream<T> {
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

    all(asStream: true): StructStream<T>;
    all(asStream: false): DataArr<T>;
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

    archived(asStream: true): StructStream<T>;
    archived(asStream: false): DataArr<T>;
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

    fromProperty(key: string, value: unknown, asStream: true): StructStream<T>;
    fromProperty(key: string, value: unknown, asStream: false): DataArr<T>;
    fromProperty(key: string, value: unknown, asStream: boolean) {
        const s = this.getStream('property', { key, value });
        if (asStream) return s;
        const arr = this.writables.get(`property:${key}:${JSON.stringify(value)}`) || new DataArr(this, []);
        this.writables.set(`property:${key}:${JSON.stringify(value)}`, arr);

        const add = (d: StructData<T>) => {
            if (d.data[key] === value) arr.add(d);
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
            this.writables.delete(`property:${key}:${JSON.stringify(value)}`);
        });
        return arr;
    }

    fromUniverse(universe: string, asStream: true): StructStream<T>;
    fromUniverse(universe: string, asStream: false): DataArr<T>;
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

    fromId(id: string) {
        return attemptAsync(async () => {
            const has = this.cache.get(id);
            if (has) return has;
            const res = await this.post(PropertyAction.Read, { type: 'id', data: id });
            const data = await res.unwrap().json();
            return this.Generator(data);
        });
    }


    private log(...args: any[]) {
        if (this.data.log) {
            console.log(this.data.name + ':', ...args);
        }
    }
};