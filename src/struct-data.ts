/* eslint-disable @typescript-eslint/no-explicit-any */
import { SQL, sql } from 'drizzle-orm';
import { attempt, attemptAsync } from 'ts-utils/check';
import { v4 as uuid } from 'uuid';
import { OnceReadMap } from 'ts-utils/map';
import chalk from 'chalk';
import { isTesting, noDataError, noTableError, TestTable } from './testing';
import { type Blank, type Struct, type Structable, globalCols, type SafeReturn } from './struct';
import { StructError, DataError } from './utils';
import { DataVersion } from './struct-data-version';


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

    get hash() {
        return this.data.hash;
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
            const prev = { ...this.data };
            if (this.struct.data.proxyClient) {
                const res = await this.struct.data.proxyClient.update(this.struct, this.id, data).unwrap();
                this.struct.emit('update', {
                    from: prev,
                    to: res,
                });
                return res;
            }
            if (!this.canUpdate) {
                throw new DataError(this.struct, 'Cannot change static data');
            }
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
            delete newData.hash;
            const hash = await this.struct.computeHash(newData).unwrap();
            await this.database
                .update(this.struct.table)
                .set({
                    ...newData,
                    updated: now,
                    hash
                })
                .where(sql`${this.struct.table.id} = ${this.id}`);

            if (config.emit === false) this.metadata.set('no-emit', true);
            if (config.source) this.metadata.set('source', config.source);
            Object.assign(this.data, {
                ...newData,
                updated: now,
                hash
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
                    const res = await this.struct.data.proxyClient.archive(this.struct, this.id).unwrap();
                    this.struct.emit('archive', this);
                    return res;
                } else {
                    const res = await this.struct.data.proxyClient.restore(this.struct, this.id).unwrap();
                    this.struct.emit('restore', this);
                    return res;
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
                const res = await this.struct.data.proxyClient.delete(this.struct, this.id).unwrap();
                this.struct.emit('delete', this);
                return res;
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
            const vhCreated = new Date();
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
     * Resets the hash of the data, this is useful if you have updated the data outside of the struct system and want to reset the hash to avoid integrity check failures.
     * @param setUpdated Whether to set the updated time to now
     * @returns {*}
     */
    resetHash(setUpdated: boolean = false) {
        return attemptAsync(async () => {
            const data = {};
            Object.assign(data, this.data);
            delete (data as any).id;
            delete (data as any).created;
            delete (data as any).updated;
            delete (data as any).archived;
            delete (data as any).attributes;
            delete (data as any).lifetime;
            delete (data as any).canUpdate;
            delete (data as any).hash;
            const hash = await this.struct.computeHash(data).unwrap();

            await this.database
                .update(this.struct.table)
                .set({
                    hash,
                    ...(setUpdated ? { updated: new Date() } : {})
                } as any)
                .where(sql`${this.struct.table.id} = ${this.id}`);
            Object.assign(this.data, {
                hash
            });
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
            if (this.struct.data.proxyClient) {
                return this.struct.data.proxyClient.setAttributes(this.struct, this.id, attributes).unwrap();
            }

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
            if (this.struct.data.proxyClient) {
                throw new DataError(this.struct, 'Cannot set static via proxy client');
            }
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