import { Redis, ConnectionClientService, ConnectionServerService } from 'redis-utils';
import { attemptAsync, type ResultPromise } from 'ts-utils/check';
import { ComplexEventEmitter } from 'ts-utils/event-emitter';
import { z } from 'zod';
import { type Blank, Struct, type Structable, type MultiConfig, type TsType, StructStream, StructData, DataVersion } from './struct';

export class RedisStructProxyClient<Name extends string, Target extends string, RedisName extends string> {
    private id = 0;
    private readonly pendingRequests = new Map<number, (data: unknown) => void>();

    private readonly em = new ComplexEventEmitter<{
        error: [Error];
        connect: void;
        disconnect: void;
        message: [
            string,
            {
                event: string;
                data: unknown;
                name: Name;
                id: number;
            }
        ]
    }>();

    public readonly on = this.em.on.bind(this.em);
    public readonly once = this.em.once.bind(this.em);
    public readonly off = this.em.off.bind(this.em);
    public readonly emit = this.em.emit.bind(this.em);

    public readonly connection: ConnectionClientService<RedisName>;

    constructor(
        public readonly config: Readonly<{
            target: Target;
            name: Name;
            maxQueueLength?: number;
        }>,
        public readonly redis: Redis<RedisName>,
    ) {
        this.connection = redis.createClient(
            config.target,
            config.maxQueueLength || 100
        );
    }

    get name() {
        return this.config.name;
    }

    get target() {
        return this.config.target;
    }

    request<TReq, TRes, D, Struct extends string>(
        event: `${Struct}.${'new' | 'delete' | 'update' | 'archive' | 'restore' | 'from-id' | 'from-property' | 'from-vhid' | 'all' | 'get' | 'lifetime-items' | 'archived' | 'get-versions' | 'restore-version' | 'delete-version' | 'set-attributes' | 'make-version' | 'from-ids'}`,
        data: TReq,
        responseSchema: z.ZodType<TRes>,
        parser: (data: TRes) => D,
        timeout = 5000
    ) {
        return attemptAsync<D>(async () => {
            const res = await this.connection.send(event, {
                data,
                timeout,
                returnType: responseSchema,
            }).unwrap();

            return parser(res as TRes);
        });
    }

    init(config?: {
        polling?: number;
    }) {
        return attemptAsync(async () => {
            this.connection.init(config).unwrap();
        });
    }

    setup(struct: Struct<Blank, string>) {
        return;
    }

    //
    new<T extends Blank, Name extends string>(struct: Struct<T, Name>, data: Structable<T>, config?: {
        emit?: boolean;
        overwriteGlobals?: boolean;
        source?: string;
        static?: boolean;
        overwriteGenerators?: boolean;
    }) {
        return this.request(
            `${struct.name}.new`,
            {
                data,
                config
            },
            struct.getZodSchema(),
            (d) => struct.Generator(d as any),
        );
    }
    //
    delete<T extends Blank, Name extends string>(struct: Struct<T, Name>, id: string) {
        return this.request(
            `${struct.name}.delete`,
            { id },
            z.void(),
            () => {}
        );
    }
    //
    update<T extends Blank, Name extends string>(struct: Struct<T, Name>, id: string, data: Partial<Structable<T>>) {
        return this.request(
            `${struct.name}.update`,
            { id, data },
            struct.getZodSchema(),
            d => struct.Generator(d as any),
        );
    }
    archive<T extends Blank, Name extends string>(struct: Struct<T, Name>, id: string) {
        return this.request(
            `${struct.name}.archive`,
            { id },
            z.void(),
            () => {}
        );
    }
    restore<T extends Blank, Name extends string>(struct: Struct<T, Name>, id: string) {
        return this.request(
            `${struct.name}.restore`,
            { id },
            z.void(),
            () => {}
        );
    }
    fromId<T extends Blank, Name extends string>(struct: Struct<T, Name>, id: string) {
        return this.request(
            `${struct.name}.from-id`,
            { id },
            struct.getZodSchema(),
            (d) => struct.Generator(d as any)
        );
    }
    fromProperty<T extends Blank, Name extends string, Prop extends keyof T>(
        struct: Struct<T, Name>,
        property: Prop,
        value: TsType<T[Prop]['_']['dataType']>,
        config: MultiConfig
    ) {
        return this.request(
            `${struct.name}.from-property`,
            { property, value, config },
            z.array(struct.getZodSchema()),
            (d) => d.map((item: any) => struct.Generator(item as any))
        );
    }
    fromVhId<T extends Blank, Name extends string>(
        struct: Struct<T, Name>,
        vhId: string
    ) {
        return this.request(
            `${struct.name}.from-vhid`,
            { vhId },
            z.object({
                vhId: z.string(),
                vhCreated: z.string(),
                data: struct.getZodSchema()
            }),
            (d) => new DataVersion(struct, {
                ...d,
                data: undefined,
                ...d.data,
            } as any)
        );
    }
    all<T extends Blank, Name extends string>(
        struct: Struct<T, Name>,
        config: MultiConfig
    ) {
        return this.request(
            `${struct.name}.all`,
            config,
            z.array(struct.getZodSchema()),
            (d) => d.map((item: any) => struct.Generator(item as any))
        );
    }
    get<T extends Blank, Name extends string>(
        struct: Struct<T, Name>,
        props: {
            [K in keyof T]?: TsType<T[K]['_']['dataType']>;
        },
        config: MultiConfig
    ) {
        return this.request(
            `${struct.name}.get`,
            { props, config },
            z.array(struct.getZodSchema()),
            (d) => d.map((item: any) => struct.Generator(item as any))
        );
    }
    getLifetimeItems<T extends Blank, Name extends string>(
        struct: Struct<T, Name>,
        config: MultiConfig,
    ) {
        return this.request(
            `${struct.name}.lifetime-items`,
            config,
            z.array(struct.getZodSchema()),
            (d) => d.map((item: any) => struct.Generator(item as any))
        );
    }
    archived<T extends Blank, Name extends string>(
        struct: Struct<T, Name>,
        config: MultiConfig
    ) {
        return this.request(
            `${struct.name}.archived`,
            config,
            z.array(struct.getZodSchema()),
            (d) => d.map((item: any) => struct.Generator(item as any))
        );
    }
    getVersions<T extends Blank, Name extends string>(
        struct: Struct<T, Name>,
        id: string,
    ) {
        return this.request(
            `${struct.name}.get-versions`,
            { id },
            z.array(z.object({
                vhId: z.string(),
                vhCreated: z.string(),
                data: struct.getZodSchema()
            })),
            (d) => d.map((item: any) => new DataVersion(struct, {
                ...item,
                data: undefined,
                ...item.data,
            } as any))
        );
    }
    restoreVersion<T extends Blank, Name extends string>(
        struct: Struct<T, Name>,
        vhId: string,
    ) {
        return this.request(
            `${struct.name}.restore-version`,
            { vhId },
            z.void(),
            () => {}
        );
    }
    deleteVersion<T extends Blank, Name extends string>(
        struct: Struct<T, Name>,
        vhId: string
    ) {
        return this.request(
            `${struct.name}.delete-version`,
            { vhId },
            z.void(),
            () => {}
        );
    }
    makeVersion<T extends Blank, Name extends string>(
        struct: Struct<T, Name>,
        vhId: string,
        data?: Partial<Structable<T>>,
    ) {
        return this.request(
            `${struct.name}.make-version`,
            { vhId, data },
            z.object({
                id: z.string(),
                data: struct.getZodSchema(),
                vhId: z.string(),
                vhCreated: z.string(),
            }),
            (d) => new DataVersion(
                struct,
                {
                    ...d,
                    data: undefined,
                    ...d.data,
                } as any
            )
        );
    }

    setAttributes<T extends Blank, Name extends string>(
        struct: Struct<T, Name>,
        id: string,
        attributes: string[],
    ) {
        return this.request(
            `${struct.name}.set-attributes`,
            { id, attributes },
            z.void(),
            () => {}
        );
    }

    fromIds<T extends Blank, Name extends string>(
        struct: Struct<T, Name>,
        ids: string[],
        config: MultiConfig
    ) {
        return this.request(
            `${struct.name}.from-ids`,
            { ids, config },
            z.array(struct.getZodSchema()),
            (d) => d.map((item: any) => struct.Generator(item as any))
        );
    }

    // I'm not sure if these should be implemented.
    /**
     * @deprecated
     */
    call() {}
    /**
     * @deprecated
     */
    query() {}
    /**
     * @deprecated
     */
    send() {}
}


export class RedisStructProxyServer<Name extends string, RedisName extends string> {
    public static readonly structEvents = {
        new: z.object({
            data: z.unknown(),
            config: z.object({
                emit: z.boolean().optional(),
                overwriteGlobals: z.boolean().optional(),
                source: z.string().optional(),
                static: z.boolean().optional(),
                overwriteGenerators: z.boolean().optional(),
            }).optional(),
            struct: z.string(),
        }),
        delete: z.object({
            data: z.object({
                id: z.string(),
            }),
            struct: z.string(),
        }),
        update: z.object({
            data: z.object({
                id: z.string(),
                data: z.record(z.unknown()),
            }),
            struct: z.string(),
        }),
        archive: z.object({
            data: z.object({
                id: z.string(),
            }),
            struct: z.string(),
        }),
        restore: z.object({
            data: z.object({
                id: z.string(),
            }),
            struct: z.string(),
        }),
        fromId: z.object({
            data: z.object({
                id: z.string(),
            }),
            struct: z.string(),
        }),
        fromProperty: z.object({
            data: z.object({
                property: z.string(),
                value: z.unknown(),
                config: z.object({
                    limit: z.number().optional(),
                    offset: z.number().optional(),
                    includeArchived: z.boolean().optional(),
                }),
            }),
            struct: z.string(),
        }),
        fromVhId: z.object({
            data: z.object({
                vhId: z.string(),
            }),
            struct: z.string(),
        }),
        all: z.object({
            data: z.object({
                limit: z.number().optional(),
                offset: z.number().optional(),
                includeArchived: z.boolean().optional(),
            }),
            struct: z.string(),
        }),
        get: z.object({
            data: z.object({
                props: z.record(z.unknown()),
                config: z.object({
                    limit: z.number().optional(),
                    offset: z.number().optional(),
                    includeArchived: z.boolean().optional(),
                }),
            }),
            struct: z.string(),
        }),
        'lifetime-items': z.object({
            data: z.object({
                limit: z.number().optional(),
                offset: z.number().optional(),
            }),
            struct: z.string(),
        }),
        archived: z.object({
            data: z.object({
                limit: z.number().optional(),
                offset: z.number().optional(),
            }),
            struct: z.string(),
        }),
        'get-versions': z.object({
            data: z.object({
                id: z.string(),
            }),
            struct: z.string(),
        }),
        'restore-version': z.object({
            data: z.object({
                vhId: z.string(),
            }),
            struct: z.string(),
        }),
        'delete-version': z.object({
            data: z.object({
                vhId: z.string(),
            }),
            struct: z.string(),
        }),
        'make-version': z.object({
            data: z.object({
                id: z.string(),
            }),
            struct: z.string(),
        }),
        'set-attributes': z.object({
            data: z.object({
                id: z.string(),
                attributes: z.array(z.string()),
            }),
            struct: z.string(),
        }),
        'from-ids': z.object({
            data: z.object({
                ids: z.array(z.string()),
                config: z.object({
                    limit: z.number().optional(),
                    offset: z.number().optional(),
                    includeArchived: z.boolean().optional(),
                }).optional(),
            }),
            struct: z.string(),
        }),
    }

    private readonly structs = new Map<string, Struct<Blank, string>>();


    private readonly em = new ComplexEventEmitter<{
        error: [Error];
        connect: void;
        disconnect: void;
        request: [{
            event: string;
            data: unknown;
            target: string;
            name: string;
            id: number;
            reply: (data: unknown) => Promise<void>;
        }];
    }>();

    public readonly on = this.em.on.bind(this.em);
    public readonly once = this.em.once.bind(this.em);
    public readonly off = this.em.off.bind(this.em);
    public readonly emit = this.em.emit.bind(this.em);

    public readonly server: ConnectionServerService<RedisName, typeof RedisStructProxyServer.structEvents>;

    constructor(
        public readonly config: Readonly<{
            name: Name;
            maxQueueLength?: number;
        }>,
        public readonly redis: Redis<RedisName>,
    ) {
        this.server = redis.createServer(
        RedisStructProxyServer.structEvents, 
        this.config.maxQueueLength || 100
    );
    }

    setup(struct: Struct<Blank, string>) {
        this.structs.set(struct.name, struct);
    }

    get name() {
        return this.config.name;
    }

    init(config?: {
        polling?: number;
    }) {
        return attemptAsync(async () => {
            await this.server.init(config).unwrap();

            this.server.subscribe('new', (data) => {
                const s = this.structs.get(data.struct);
                if (!s) {
                    throw new Error(`Struct ${data.struct} not found in RedisStructProxyServer`);
                }

                return s.new(data.data as any, data.config).unwrap().then(d => d.data);
            });

            this.server.subscribe('delete', async (data) => {
                const s = this.structs.get(data.struct);
                if (!s) {
                    throw new Error(`Struct ${data.struct} not found in RedisStructProxyServer`);
                }

                const item = await s.fromId(data.data.id).unwrap();
                if (!item) {
                    throw new Error(`Item with id ${data.data.id} not found in struct ${data.struct}`);
                }

                return item.delete().unwrap();
            });

            this.server.subscribe('update', async (data) => {
                const s = this.structs.get(data.struct);
                if (!s) {
                    throw new Error(`Struct ${data.struct} not found in RedisStructProxyServer`);
                }

                const item = await s.fromId(data.data.id).unwrap();
                if (!item) {
                    throw new Error(`Item with id ${data.data.id} not found in struct ${data.struct}`);
                }

                await item.update(data.data.data as any).unwrap();
                return item.data;
            });

            this.server.subscribe('archive', async (data) => {
                const s = this.structs.get(data.struct);
                if (!s) {
                    throw new Error(`Struct ${data.struct} not found in RedisStructProxyServer`);
                }

                const item = await s.fromId(data.data.id).unwrap();
                if (!item) {
                    throw new Error(`Item with id ${data.data.id} not found in struct ${data.struct}`);
                }

                return item.setArchive(true).unwrap();
            });

            this.server.subscribe('restore', async (data) => {
                const s = this.structs.get(data.struct);
                if (!s) {
                    throw new Error(`Struct ${data.struct} not found in RedisStructProxyServer`);
                }

                const item = await s.fromId(data.data.id).unwrap();
                if (!item) {
                    throw new Error(`Item with id ${data.data.id} not found in struct ${data.struct}`);
                }

                return item.setArchive(false).unwrap();
            });

            this.server.subscribe('fromId', async (data) => {
                const s = this.structs.get(data.struct);
                if (!s) {
                    throw new Error(`Struct ${data.struct} not found in RedisStructProxyServer`);
                }

                return s.fromId(data.data.id).unwrap().then(d => d?.data);
            });

            this.server.subscribe('fromProperty', async (data) => {
                const s = this.structs.get(data.struct);
                if (!s) {
                    throw new Error(`Struct ${data.struct} not found in RedisStructProxyServer`);
                }

                const config = {};

                if (data.data.config.limit && !isNaN(data.data.config.limit)) {
                    (config as any).limit = Number(data.data.config.limit);
                    (config as any).offset = data.data.config.offset && !isNaN(data.data.config.offset) ? data.data.config.offset : 0;
                    (config as any).type = 'array';
                } else {
                    (config as any).type = 'all';
                }

                (config as any).includeArchived = data.data.config.includeArchived;

                return s.fromProperty(data.data.property, data.data.value as any, {
                    type: 'all', // for typing purposes
                    ...config,
                }).unwrap().then(d => d.map(i => i.data));
            });

            this.server.subscribe('fromVhId', async (data) => {
                const s = this.structs.get(data.struct);
                if (!s) {
                    throw new Error(`Struct ${data.struct} not found in RedisStructProxyServer`);
                }

                return s.fromVhId(data.data.vhId).unwrap().then(d => d?.data);
            });

            this.server.subscribe('all', async (data) => {
                const s = this.structs.get(data.struct);
                if (!s) {
                    throw new Error(`Struct ${data.struct} not found in RedisStructProxyServer`);
                }

                const config = {};

                if (data.data.limit && !isNaN(data.data.limit)) {
                    (config as any).limit = Number(data.data.limit);
                    (config as any).offset = data.data.offset && !isNaN(data.data.offset) ? data.data.offset : 0;
                    (config as any).type = 'array';
                } else {
                    (config as any).type = 'all';
                }

                (config as any).includeArchived = data.data.includeArchived;

                return s.all({
                    type: 'all', // for typing purposes
                    ...config,
                }).unwrap().then(d => d.map(i => i.data));
            });

            this.server.subscribe('get', async (data) => {
                const s = this.structs.get(data.struct);
                if (!s) {
                    throw new Error(`Struct ${data.struct} not found in RedisStructProxyServer`);
                }

                const config = {};

                if (data.data.config.limit && !isNaN(data.data.config.limit)) {
                    (config as any).limit = Number(data.data.config.limit);
                    (config as any).offset = data.data.config.offset && !isNaN(data.data.config.offset) ? data.data.config.offset : 0;
                    (config as any).type = 'array';
                } else {
                    (config as any).type = 'all';
                }

                (config as any).includeArchived = data.data.config.includeArchived;

                return s.get(data.data.props as any, {
                    type: 'all', // for typing purposes
                    ...config,
                }).unwrap().then(d => d.map(i => i.data));
            });

            this.server.subscribe('lifetime-items', async (data) => {
                const s = this.structs.get(data.struct);
                if (!s) {
                    throw new Error(`Struct ${data.struct} not found in RedisStructProxyServer`);
                }

                const config = {};

                if (data.data.limit && !isNaN(data.data.limit)) {
                    (config as any).limit = Number(data.data.limit);
                    (config as any).offset = data.data.offset && !isNaN(data.data.offset) ? data.data.offset : 0;
                    (config as any).type = 'array';
                } else {
                    (config as any).type = 'all';
                }

                return s.getLifetimeItems({
                    type: 'all', // for typing purposes
                    ...config,
                }).unwrap().then(d => d.map(i => i.data));
            });

            this.server.subscribe('archived', async (data) => {
                const s = this.structs.get(data.struct);
                if (!s) {
                    throw new Error(`Struct ${data.struct} not found in RedisStructProxyServer`);
                }

                const config = {};

                if (data.data.limit && !isNaN(data.data.limit)) {
                    (config as any).limit = Number(data.data.limit);
                    (config as any).offset = data.data.offset && !isNaN(data.data.offset) ? data.data.offset : 0;
                    (config as any).type = 'array';
                } else {
                    (config as any).type = 'all';
                }

                return s.archived({
                    type: 'all', // for typing purposes
                    ...config,
                }).unwrap().then(d => d.map(i => i.data));
            });

            this.server.subscribe('get-versions', async (data) => {
                const s = this.structs.get(data.struct);
                if (!s) {
                    throw new Error(`Struct ${data.struct} not found in RedisStructProxyServer`);
                }

                const item = await s.fromId(data.data.id).unwrap();
                if (!item) {
                    throw new Error(`Item with id ${data.data.id} not found in struct ${data.struct}`);
                }
                return item.getVersions().unwrap().then(d => d.map(i => i.data));
            });

            this.server.subscribe('restore-version', async (data) => {
                const s = this.structs.get(data.struct);
                if (!s) {
                    throw new Error(`Struct ${data.struct} not found in RedisStructProxyServer`);
                }

                const version = await s.fromVhId(data.data.vhId).unwrap();
                if (!version) {
                    throw new Error(`Version with vhId ${data.data.vhId} not found in struct ${data.struct}`);
                }

                return version.restore().unwrap();
            });

            this.server.subscribe('delete-version', async (data) => {
                const s = this.structs.get(data.struct);
                if (!s) {
                    throw new Error(`Struct ${data.struct} not found in RedisStructProxyServer`);
                }

                const version = await s.fromVhId(data.data.vhId).unwrap();
                if (!version) {
                    throw new Error(`Version with vhId ${data.data.vhId} not found in struct ${data.struct}`);
                }

                return version.delete().unwrap();
            });

            this.server.subscribe('make-version', async (data) => {
                const s = this.structs.get(data.struct);
                if (!s) {
                    throw new Error(`Struct ${data.struct} not found in RedisStructProxyServer`);
                }

                const item = await s.fromId(data.data.id).unwrap();
                if (!item) {
                    throw new Error(`Item with id ${data.data.id} not found in struct ${data.struct}`);
                }
                return item.makeVersion().unwrap();
            });

            this.server.subscribe('set-attributes', async (data) => {
                const s = this.structs.get(data.struct);
                if (!s) {
                    throw new Error(`Struct ${data.struct} not found in RedisStructProxyServer`);
                }

                const item = await s.fromId(data.data.id).unwrap();
                if (!item) {
                    throw new Error(`Item with id ${data.data.id} not found in struct ${data.struct}`);
                }
                return item.setAttributes(data.data.attributes).unwrap();
            });

            this.server.subscribe('from-ids', async (data) => {
                const s = this.structs.get(data.struct);
                if (!s) {
                    throw new Error(`Struct ${data.struct} not found in RedisStructProxyServer`);
                }

                return s.fromIds(data.data.ids, {
                    type: 'all',
                    ...data.data.config,
                }).unwrap().then(d => d.map(i => i.data));
            });
        });
    }
}