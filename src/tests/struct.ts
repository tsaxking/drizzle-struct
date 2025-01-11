import { Struct, StructData, StructStream } from "../back-end";

export class TestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TestError';
    }
}

export const runTest = async (struct: Struct): Promise<{
    all: () => Promise<void>;
    fromProperty: () => Promise<void>;
    archived: () => Promise<void>;
    generate: () => Promise<void>;
    get: () => Promise<void>;
    clear: () => Promise<void>;
}> => {
    if (!Object.hasOwn(struct.data.structure, 'name')) {
        throw new Error('Test Struct: Name property is required (text)');
    }
    if (!Object.hasOwn(struct.data.structure, 'age')) {
        throw new Error('Test Struct: Age property is required (integer)');
    }

    if (struct.data.structure.name.config.dataType !== 'string') {
        throw new Error('Test Struct: Name property must be a string');
    }

    if (struct.data.structure.age.config.dataType !== 'number') {
        throw new Error('Test Struct: Age property must be a number');
    }

    if (!struct.built) {
        throw new TestError('Test Struct: Struct is not built');
    }

    (await struct.clear()).unwrap();

    return {
        async all() {
            const stream = struct.all({
                type: 'stream',
            });

            if (!(stream instanceof StructStream)) {
                throw new TestError('Test Struct: All method did not return a StructStream');
            }

            const array = struct.all({
                type: 'array',
                limit: 10,
                offset: 0,
            });

            if (!Array.isArray(array)) {
                throw new TestError('Test Struct: All method did not return an array');
            }

            const object = struct.all({
                type: 'single',
            });

            if (typeof object !== 'object') {
                throw new TestError('Test Struct: All method did not return an object');
            }
        },
        async fromProperty() {
            const stream = struct.fromProperty('name' as any, 'John', {
                type: 'stream',
            });

            if (!(stream instanceof StructStream)) {
                throw new TestError('Test Struct: FromProperty method did not return a StructStream');
            }

            const array = await struct.fromProperty('name' as any, 'John', {
                type: 'array',
                limit: 10,
                offset: 0,
            });

            if (!Array.isArray(array)) {
                throw new TestError('Test Struct: FromProperty method did not return an array');
            }

            const object = await struct.fromProperty('name' as any, 'John', {
                type: 'single',
            });

            if (typeof object !== 'object') {
                throw new TestError('Test Struct: FromProperty method did not return an object');
            }
        },
        async archived() {
            const stream = struct.archived({
                type: 'stream',
            });

            if (!(stream instanceof StructStream)) {
                throw new TestError('Test Struct: Archived method did not return a StructStream');
            }

            const array = struct.archived({
                type: 'array',
                limit: 10,
                offset: 0,
            });

            if (!Array.isArray(array)) {
                throw new TestError('Test Struct: Archived method did not return an array');
            }

            const object = struct.archived({
                type: 'single',
            });

            if (typeof object !== 'object') {
                throw new TestError('Test Struct: Archived method did not return an object');
            }
        },
        async generate() {
            const data = (await struct.new({
                name: 'John',
                age: 25,
            })).unwrap();

            if (data.data.name !== 'John') {
                throw new TestError('Test Struct: Generate method did not return the correct data');
            }

            if (data.data.age !== 25) {
                throw new TestError('Test Struct: Generate method did not return the correct data');
            }

            (await data.update({
                age: 26,
            })).unwrap();

            const select = (await struct.fromId(data.id as string)).unwrap();

            if (!select) {
                throw new TestError('Test Struct: Generate method did not return the correct data');
            }

            if (select.data.age !== 26) {
                throw new TestError('Test Struct: Generate method did not return the correct data');
            }

            (await select.delete()).unwrap();
        },
        async get() {
            const data = (await struct.new({
                name: 'John',
                age: 25,
            })).unwrap();

            const select = (await struct.get({
                id: data.id as string,
            }, {
                type: 'single',
            })).unwrap();

            if (!(select instanceof StructData)) {
                throw new TestError('Test Struct: Get method did not return the correct data');
            }
        },
        async clear() {
            await struct.clear();
        }
    }
};