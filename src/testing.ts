/* eslint-disable @typescript-eslint/no-explicit-any */
import { attempt } from "ts-utils/check";
import { type Blank, Struct, StructData } from "./back-end";
import { z } from 'zod';
import { v4 as uuid } from 'uuid';

const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const log = (...data: unknown[])  => {
    console.log(
        // red
        RED,
        '[Struct Testing]',
        // reset
        RESET,
        ...data,
    );
};
const warn = (...data: unknown[]) => {
    console.warn(
        // red
        RED,
        '[Struct Testing]',
        // reset
        RESET,
        ...data,
    );
};
const error = (...data: unknown[]) => {
    console.error(
        // red
        RED,
        '[Struct Testing]',
        // reset
        RESET,
        ...data,
    );
};

export const noTableError = (struct: Struct<any, any>) => {
    return new Error(`isTesting(${struct.data.name}) is true, but there is no struct found.`);
}

export const noDataError = (structData: StructData<any, any>) => {
    return new Error(`No data with ${structData.id} found in testing table ${structData.struct.name}`)
}

export const startTesting = (config: {
    timeout: number;
    structs: Struct<any, any>[],
    maxRows: number;
    log: boolean;
}) => {
    log('Initializing tests', config.structs.map(s => s.name).join(', '))
    for (const struct of config.structs) {
        TestTable.tables.set(struct.name, new TestTable({
            maxRows: config.maxRows,
            struct,
            log: config.log,
        }));
    }
    setTimeout(() => {
        endTesting(config);
    }, config.timeout);
}

export const endTesting = (config: {
    structs: Struct<any, any>[]
}) => {
    log('Deinitializing tests', ...config.structs.map(s => s.data.name).join(', '));
    for (const struct of config.structs) {
        const table = TestTable.tables.get(struct.name);
        if (table) {
            table.clear();
        }
        TestTable.tables.delete(struct.name);
    }
}

export const isTesting = (struct: Struct<any, any>) => {
    return TestTable.tables.has(struct.name);
}

type TestBlank = Record<string, unknown> & {
    id: string;
    created: Date;
    updated: Date;
    archived: boolean;
    attributes: string;
    lifetime: number;
    canUpdate: boolean;
}

type TestVersionBlank = TestBlank & {
    vhId: string;
    vhCreated: Date;
}

export class TestRow<T extends TestBlank> {
    constructor(
        public readonly table: TestTable<T>,
        public readonly data: T
    ) {}

    update(data: Partial<T>) {
        return attempt(() => {
            this.table.log(`TestRow.update called for id=${this.data.id}`);
            if (!this.data.canUpdate) {
                throw new Error('Cannot update static data');
            }
            const res = this.table.config.struct.validate(data);
            if (!res.success) {
                throw new Error(`Validation failed: ${res.reason}`);
            }
            Object.assign(this.data, data);
        });
    }

    delete() {
        return attempt(() => {
            this.table.log(`TestRow.delete called for id=${this.data.id}`);
            this.table.data.splice(
                this.table.data.indexOf(this),
                1
            );
        });
    }

    setArchive(archive: boolean) {
        return attempt(() => {
            this.table.log(`TestRow.setArchive called for id=${this.data.id}, archive=${archive}`);
            this.data.archived = archive;
        });
    }
    getAttributes() {
        return attempt(() => {
            const attrs = z.array(z.string()).parse(JSON.parse(this.data.attributes));
            this.table.log(`TestRow.getAttributes called for id=${this.data.id}, count=${attrs.length}`);
            return attrs;
        });
    }

    setAttributes(...attributes: string[]) {
        return attempt(() => {
            this.table.log(`TestRow.setAttributes called for id=${this.data.id}, attributes=${JSON.stringify(attributes)}`);
            this.data.attributes = JSON.stringify(Array.from(new Set(attributes)));
        });
    }

    addAttributes(...attributes: string[]) {
        return attempt(() => {
            this.table.log(`TestRow.addAttributes called for id=${this.data.id}, attributes=${JSON.stringify(attributes)}`);
            const attr = new Set([...this.getAttributes().unwrap(), ...attributes]);
            this.setAttributes(...attr);
        });
    }

    removeAttributes(...attributes: string[]) {
        return attempt(() => {
            this.table.log(`TestRow.removeAttributes called for id=${this.data.id}, attributes=${JSON.stringify(attributes)}`);
            const attr = this.getAttributes().unwrap()
                .filter(a => !attributes.includes(a));
            this.setAttributes(...attr);
        });
    }

    safe(...omit: string[]) {
        const data = {...this.data};
        omit.push(...(this.table.config.struct.data.safes || []));
        for (const key of omit) {
            delete data[key as keyof typeof data];
        }
        this.table.log(`TestRow.safe called for id=${this.data.id}, omit=${JSON.stringify(omit)}`);
        return data;
    }

    unsafe(...omit: string[]) {
        const data = {...this.data};
        for (const key of omit) {
            delete data[key as keyof typeof data];
        }
        this.table.log(`TestRow.unsafe called for id=${this.data.id}, omit=${JSON.stringify(omit)}`);
        return data;
    }

    getVersions() {
        return attempt(() => {
            const versions = this.table.versions.filter(v => v.data.id === this.data.id);
            this.table.log(`TestRow.getVersions called for id=${this.data.id}, count=${versions.length}`);
            return versions;
        });
    }

    makeVersion() {
        return attempt(() => {
            this.table.log(`TestRow.makeVersion called for id=${this.data.id}`);
            const version = new TestRowVersion(this.table, {
                ...this.data,
                vhId: uuid(),
                vhCreated: new Date(),
            });
            this.table.versions.push(version as any);
            return version;
        });
    }
}

export class TestRowVersion<T extends TestVersionBlank> {
    constructor(
        public readonly table: TestTable<T>,
        public readonly data: T
    ) {}


    delete() {
        return attempt(() => {
            this.table.log(`TestRowVersion.delete called for vhId=${this.data.vhId}`);
            this.table.versions.splice(
                this.table.versions.indexOf(this),
                1
            );
        });
    }

    restore() {
        return attempt(() => {
            this.table.log(`TestRowVersion.restore called for vhId=${this.data.vhId}`);
            const d = this.table.fromId(this.data.id).unwrap();
            if (d) d.update(this.data);
            else this.table.new(this.data);
        });
    }

    getAttributes() {
        return attempt(() => {
            const attrs = z.array(z.string()).parse(JSON.parse(this.data.attributes));
            this.table.log(`TestRowVersion.getAttributes called for vhId=${this.data.vhId}, count=${attrs.length}`);
            return attrs;
        });
    }
}

export type TestTableConfig = {
    maxRows: number;
    struct: Struct<Blank, string>;
    log: boolean;
}

export class TestTable<T extends TestBlank> {
    public static readonly tables = new Map<string, TestTable<any>>();

    public static get(name: string) {
        return TestTable.tables.get(name);
    }

    public readonly data: TestRow<T>[] = [];
    public readonly versions: TestRowVersion<T & {
        vhId: string;
        vhCreated: Date;
    }>[] = [];

    constructor(
        public readonly config: TestTableConfig
    ) {}

    new(data: T) {
        return attempt(() => {
            this.log(`TestTable.new called for id=${data.id}`);
            if (this.fromId(data.id).unwrap()) {
                throw new Error('Cannot add duplicate entry')
            }
            if (this.data.length === this.config.maxRows) {
                throw new Error('Cannot add more entries, max rows reached');
            }

            const res = this.config.struct.validate(data);
            if (!res.success) {
                throw new Error(`Validation failed: ${res.reason}`);
            }

            const d = new TestRow(this, data);
            this.data.push(d);
            return d;
        });
    }

    fromId(id: string) {
        return attempt(() => {
            const found = this.data.find(d => d.data.id === id);
            this.log(`TestTable.fromId called for id=${id}, found=${!!found}`);
            return found;
        });
    }

    fromProperty<K extends keyof T>(
        property: K,
        value: T[K]
    ) {
        return attempt(() => {
            const filtered = this.data.filter(d => d.data[property] === value);
            this.log(`TestTable.fromProperty called for property=${String(property)}, value=${String(value)}, count=${filtered.length}`);
            return filtered;
        });
    }

    archived() {
        return attempt(() => {
            const archived = this.data.filter(d => d.data.archived);
            this.log(`TestTable.archived called, count=${archived.length}`);
            return archived;
        });
    }

    fromVhId(vhId: string) {
        return attempt(() => {
            const found = this.versions.find(v => v.data.vhId === vhId);
            this.log(`TestTable.fromVhId called for vhId=${vhId}, found=${!!found}`);
            return found;
        });
    }

    all() {
        return attempt(() => {
            const items = this.data;
            this.log(`TestTable.all called, count=${items.length}`);
            return items;
        });
    }

    get(props: Partial<T>) {
        return attempt(() => {
            const d = this.data.filter(d => Object.entries(props).every(([key, value]) => d.data[key as keyof T] === value));
            this.log(`TestTable.get called for props=${JSON.stringify(props)}, count=${d.length}`);
            return d;
        });
    }

    clear() {
        return attempt(() => {
            this.log(`TestTable.clear called`);
            this.log('Clearing tables');
            this.data.length = 0;
            this.versions.length = 0;
        });
    }

    getLifetimeItems() {
        return attempt(() => {
            const items = this.data.filter(d => d.data.lifetime > 0);
            this.log(`TestTable.getLifetimeItems called, count=${items.length}`);
            return items;
        });
    }

    log(...data: unknown[]) {
        if (this.config.log) {
            log(
                `(${this.config.struct.data.name})`,
                ...data,
            );
        }
    }

    fromIds(ids: string[]) {
        return attempt(() => {
            const items = this.data.filter(d => ids.includes(d.data.id));
            this.log(`TestTable.fromIds called for ids=${JSON.stringify(ids)}, count=${items.length}`);
            return items;
        });
    }
}