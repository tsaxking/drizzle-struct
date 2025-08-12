import { 
    type createClient
} from 'redis';
import { attempt, attemptAsync, type ResultPromise } from 'ts-utils/check';
import { ComplexEventEmitter } from 'ts-utils/event-emitter';
import { z } from 'zod';
import { type Blank, Struct, type Structable, type MultiConfig, type TsType, StructStream, StructData, DataVersion } from './back-end';

type RedisClient = ReturnType<typeof createClient>;

export class RedisStructProxyClient<Name extends string, Target extends string> {
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
                target: Target;
                name: Name;
                id: number;
            }
        ]
    }>();

    public readonly on = this.em.on.bind(this.em);
    public readonly once = this.em.once.bind(this.em);
    public readonly off = this.em.off.bind(this.em);
    public readonly emit = this.em.emit.bind(this.em);

    constructor(
        public readonly config: Readonly<{
            pub: RedisClient;
            sub: RedisClient;
            target: Target;
            name: Name;
        }>
    ) {}

    get name() {
        return this.config.name;
    }

    get target() {
        return this.config.target;
    }

    get pub(): RedisClient {
        return this.config.pub;
    }

    get sub(): RedisClient {
        return this.config.sub;
    }

    private parseMessage<T>(
        message: string,
        schema: z.ZodType<T>
    ) {
        return attempt<{
            event: string;
            data: T;
            target: Target;
            name: Name;
            id: number;
        }>(() => {
            return z.object({
                event: z.string(),
                data: schema,
                target: z.string(),
                name: z.string(),
                id: z.number(),
            }).parse(JSON.parse(message)) as {
                event: string;
                data: T;
                target: Target;
                name: Name;
                id: number;
            };
        });
    }

    private _send(
        event: string,
        data: unknown,
        id?: number
    ) {
        return attemptAsync(async () => {
            const { pub, target, name } = this;
            const message = JSON.stringify({
                event,
                data,
                target,
                name,
                id: id ?? this.id++,
            });
            await pub.publish(target, message);
            return message;
        });
    }

    request<TReq, TRes>(
        event: `${string}.${'new' | 'delete' | 'update' | 'archive' | 'restore' | 'from-id' | 'from-property' | 'from-vhid' | 'all' | 'get' | 'lifetime-items' | 'archived' | 'get-versions' | 'restore-version' | 'delete-version'}`,
        data: TReq,
        responseSchema: z.ZodType<TRes>,
        timeoutMs = 5000
    ) {
        const id = this.id++;

        return attemptAsync<TRes>(async () => {
            return new Promise<TRes>((res, rej) => {
                const timeout = setTimeout(rej, timeoutMs);
                this._send(event, data, id);

                this.pendingRequests.set(id, (data) => {
                    const parsed = responseSchema.safeParse(data);
                    if (parsed.success) {
                        res(parsed.data);
                        clearTimeout(timeout);
                        this.pendingRequests.delete(id);
                    } else if (parsed.error instanceof z.ZodError) {
                        this.em.emit('error', parsed.error);
                        clearTimeout(timeout);
                        this.pendingRequests.delete(id);
                        rej(parsed.error);
                    } else {
                        rej(parsed.error);
                    }
                });
            });
        });
    }

    connect() {
        return attemptAsync(() => {
            return new Promise<void>((res, rej) => {
                const { sub } = this;
                sub.subscribe(this.target, (err) => {
                    if (err) {
                        this.em.emit('error', new Error(err));
                        return rej(err);
                    }

                    sub.on('message', (channel, message) => {
                        const parsed = this.parseMessage(message, z.unknown());
                        if (!parsed.isOk()) {
                            this.em.emit('error', parsed.error);
                            return;
                        }

                        const msg = parsed.value;
                        this.em.emit('message', channel, msg);

                        const pending = this.pendingRequests.get(msg.id);
                        if (pending) {
                            pending(msg.data);
                        }
                    });

                    this.em.emit('connect');
                    res();
                });
            });
        });
    }

    setup(struct: Struct<Blank, string>) {
        // I don't know if this should do anything.
        struct.log('Setting up RedisStructProxyClient for', this.name, 'target', this.target);
    }

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
            struct.getZodSchema()
        );
    }
    delete<T extends Blank, Name extends string>(struct: Struct<T, Name>, id: string) {
        return this.request(
            `${struct.name}.delete`,
            { id },
            z.void()
        );
    }
    update<T extends Blank, Name extends string>(struct: Struct<T, Name>, id: string, data: Partial<Structable<T>>) {
        return this.request(
            `${struct.name}.update`,
            { id, data },
            z.void()
        );
    }
    archive<T extends Blank, Name extends string>(struct: Struct<T, Name>, id: string) {
        return this.request(
            `${struct.name}.archive`,
            { id },
            z.void()
        );
    }
    restore<T extends Blank, Name extends string>(struct: Struct<T, Name>, id: string) {
        return this.request(
            `${struct.name}.restore`,
            { id },
            z.void()
        );
    }
    fromId<T extends Blank, Name extends string>(struct: Struct<T, Name>, id: string) {
        return this.request(
            `${struct.name}.from-id`,
            { id },
            struct.getZodSchema()
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
            z.array(struct.getZodSchema())
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
                ...struct.getZodSchema().shape,
                vhId: z.string(),
                vhCreated: z.string(),
            })
        );
    }
    all<T extends Blank, Name extends string>(
        struct: Struct<T, Name>,
        config: MultiConfig
    ) {
        return this.request(
            `${struct.name}.all`,
            config,
            z.array(struct.getZodSchema())
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
            z.array(struct.getZodSchema())
        );
    }
    getLifetimeItems<T extends Blank, Name extends string>(
        struct: Struct<T, Name>,
        config: MultiConfig,
    ) {
        return this.request(
            `${struct.name}.lifetime-items`,
            config,
            z.array(struct.getZodSchema())
        );
    }
    archived<T extends Blank, Name extends string>(
        struct: Struct<T, Name>,
        config: MultiConfig
    ) {
        return this.request(
            `${struct.name}.archived`,
            config,
            z.array(struct.getZodSchema())
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
            }))
        );
    }
    restoreVersion<T extends Blank, Name extends string>(
        struct: Struct<T, Name>,
        vhId: string,
    ) {
        return this.request(
            `${struct.name}.restore-version`,
            { vhId },
            z.void()
        );
    }
    deleteVersion<T extends Blank, Name extends string>(
        struct: Struct<T, Name>,
        vhId: string
    ) {
        return this.request(
            `${struct.name}.delete-version`,
            { vhId },
            z.void()
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

export class RedisStructProxyServer<Name extends string> {
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

    constructor(
        public readonly config: Readonly<{
            pub: RedisClient;
            sub: RedisClient;
            name: Name;
        }>
    ) {}

    setup(struct: Struct<Blank, string>) {
        this.structs.set(struct.name, struct);
    }

    get name() {
        return this.config.name;
    }

    get pub(): RedisClient {
        return this.config.pub;
    }

    get sub(): RedisClient {
        return this.config.sub;
    }

    parseMessage<T>(
        message: string,
        schema: z.ZodType<T>
    ) {
        return attempt<{
            event: string;
            data: T;
            target: string;
            name: string;
            id: number;
        }>(() => {
            return z.object({
                event: z.string(),
                data: schema,
                target: z.string(),
                name: z.string(),
                id: z.number(),
            }).parse(JSON.parse(message)) as {
                event: string;
                data: T;
                target: string;
                name: Name;
                id: number;
            };
        });
    }

    reply(
        target: string,
        id: number,
        event: string,
        data: unknown
    ) {
        return attemptAsync(async () => {
            const message = JSON.stringify({
                event,
                data,
                target,
                name: this.name,
                id,
            });
            await this.pub.publish(target, message);
        });
    }

    connect() {
        const { sub } = this;

        return attemptAsync(() => {
            return new Promise<void>((res, rej) => {
                sub.subscribe(this.name, (err) => {
                    if (err) {
                        this.em.emit('error', new Error(err));
                        return rej(err);
                    }

                    sub.on('message', async (channel, message) => {
                        const parsed = this.parseMessage(message, z.unknown());
                        if (!parsed.isOk()) {
                            this.em.emit('error', parsed.error);
                            return;
                        }

                        const [struct, event] = parsed.value.event.split('.');
                        if (!this.structs.has(struct)) {
                            return this.reply(
                                parsed.value.target,
                                parsed.value.id,
                                'error',
                                new Error(`Struct ${struct} not found`)
                            );
                        } else if (!event) {
                            return this.reply(
                                parsed.value.target,
                                parsed.value.id,
                                'error',
                                new Error(`Event ${event} not found.`)
                            );
                        } else {
                            switch (event) {
                                case 'new': {
                                    const structInstance = this.structs.get(struct);
                                    if (!structInstance) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Struct ${struct} not found`)
                                        );
                                    }
                                    const data = z.object({
                                        data: structInstance.getZodSchema(),
                                        config: z.object({
                                            emit: z.boolean().optional().default(true),
                                            overwriteGlobals: z.boolean().optional().default(false),
                                            source: z.string().optional(),
                                            static: z.boolean().optional().default(false),
                                            overwriteGenerators: z.boolean().optional().default(false)
                                        }).partial().optional().default({})
                                    }).safeParse(parsed.value.data);
                                    if (!data.success) {
                                        structInstance.log('Error parsing data for new:', data.error);
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            data.error
                                        );
                                    }
                                    const res = await structInstance.new(data.data.data, data.data.config);
                                    if (res.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            res.error
                                        );
                                    }
                                    return this.reply(parsed.value.target, parsed.value.id, 'new', res.value);
                                }
                                case 'delete': {
                                    const structInstance = this.structs.get(struct);
                                    if (!structInstance) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Struct ${struct} not found`)
                                        );
                                    }
                                    const p = z.object({ id: z.string(), }).safeParse(parsed.value.data);
                                    if (!p.success) {
                                        structInstance.log('Error parsing data for delete:', p.error);
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            p.error
                                        );
                                    }
                                    const { id } = p.data;
                                    const res = await structInstance.fromId(id);
                                    if (res.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            res.error
                                        );
                                    }
                                    if (!res.value) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Item with id ${id} not found`)
                                        );
                                    }
                                    const deleteRes = await res.value.delete();
                                    if (deleteRes.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            deleteRes.error
                                        );
                                    }
                                    return this.reply(parsed.value.target, parsed.value.id, 'delete', undefined);
                                }
                                case 'update': {
                                    const structInstance = this.structs.get(struct);
                                    if (!structInstance) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Struct ${struct} not found`)
                                        );
                                    }
                                    const p = z.object({
                                        id: z.string(),
                                        data: structInstance.getZodSchema().partial()
                                    }).safeParse(parsed.value.data);
                                    if (!p.success) {
                                        structInstance.log('Error parsing data for update:', p.error);
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            p.error
                                        );
                                    }
                                    const { id, data } = p.data;
                                    const res = await structInstance.fromId(id);
                                    if (res.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            res.error
                                        );
                                    }
                                    if (!res.value) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Item with id ${id} not found`)
                                        );
                                    }
                                    const updateRes = await res.value.update(data);
                                    if (updateRes.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            updateRes.error
                                        );
                                    }
                                    return this.reply(parsed.value.target, parsed.value.id, 'update', updateRes.value);
                                }
                                case 'archive': {
                                    const structInstance = this.structs.get(struct);
                                    if (!structInstance) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Struct ${struct} not found`)
                                        );
                                    }
                                    const p = z.object({ id: z.string(), }).safeParse(parsed.value.data);
                                    if (!p.success) {
                                        structInstance.log('Error parsing data for archive:', p.error);
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            p.error
                                        );
                                    }
                                    const { id } = p.data;
                                    const res = await structInstance.fromId(id);
                                    if (res.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            res.error
                                        );
                                    }
                                    if (!res.value) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Item with id ${id} not found`)
                                        );
                                    }
                                    const archiveRes = await res.value.setArchive(true);
                                    if (archiveRes.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            archiveRes.error
                                        );
                                    }
                                    return this.reply(parsed.value.target, parsed.value.id, 'archive', archiveRes.value);
                                }
                                case 'restore': {
                                    const structInstance = this.structs.get(struct);
                                    if (!structInstance) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Struct ${struct} not found`)
                                        );
                                    }
                                    const p = z.object({ id: z.string(), }).safeParse(parsed.value.data);
                                    if (!p.success) {
                                        structInstance.log('Error parsing data for restore:', p.error);
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            p.error
                                        );
                                    }
                                    const { id } = p.data;
                                    const res = await structInstance.fromId(id);
                                    if (res.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            res.error
                                        );
                                    }
                                    if (!res.value) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Item with id ${id} not found`)
                                        );
                                    }
                                    const restoreRes = await res.value.setArchive(false);
                                    if (restoreRes.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            restoreRes.error
                                        );
                                    }
                                    return this.reply(parsed.value.target, parsed.value.id, 'restore', restoreRes.value);
                                }
                                case 'restore-version': {
                                    const structInstance = this.structs.get(struct);
                                    if (!structInstance) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Struct ${struct} not found`)
                                        );
                                    }
                                    const p = z.object({ vhId: z.string(), }).safeParse(parsed.value.data);
                                    if (!p.success) {
                                        structInstance.log('Error parsing data for restore version:', p.error);
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            p.error
                                        );
                                    }
                                    const { vhId } = p.data;
                                    const res = await structInstance.fromVhId(vhId);
                                    if (res.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            res.error
                                        );
                                    }
                                    if (!res.value) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Item with vhId ${vhId} not found`)
                                        );
                                    }
                                    const restoreRes = await res.value.restore();
                                    if (restoreRes.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            restoreRes.error
                                        );
                                    }
                                    return this.reply(parsed.value.target, parsed.value.id, 'restore-version', restoreRes.value);
                                }
                                case 'delete-version': {
                                    const structInstance = this.structs.get(struct);
                                    if (!structInstance) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Struct ${struct} not found`)
                                        );
                                    }
                                    const p = z.object({ vhId: z.string(), }).safeParse(parsed.value.data);
                                    if (!p.success) {
                                        structInstance.log('Error parsing data for delete version:', p.error);
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            p.error
                                        );
                                    }
                                    const { vhId } = p.data;
                                    const res = await structInstance.fromVhId(vhId);
                                    if (res.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            res.error
                                        );
                                    }
                                    if (!res.value) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Item with vhId ${vhId} not found`)
                                        );
                                    }
                                    const deleteRes = await res.value.delete();
                                    if (deleteRes.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            deleteRes.error
                                        );
                                    }
                                    return this.reply(parsed.value.target, parsed.value.id, 'delete-version', deleteRes.value);
                                }
                                case 'fromId': {
                                    const structInstance = this.structs.get(struct);
                                    if (!structInstance) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Struct ${struct} not found`)
                                        );
                                    }
                                    const p = z.object({ id: z.string(), }).safeParse(parsed.value.data);
                                    if (!p.success) {
                                        structInstance.log('Error parsing data for fromId:', p.error);
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            p.error
                                        );
                                    }
                                    const { id } = p.data;
                                    const res = await structInstance.fromId(id);
                                    if (res.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            res.error
                                        );
                                    }
                                    return this.reply(parsed.value.target, parsed.value.id, 'fromId', res.value);
                                }
                                case 'from-property': {
                                    const structInstance = this.structs.get(struct);
                                    if (!structInstance) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Struct ${struct} not found`)
                                        );
                                    }
                                    const p = z.object({
                                        property: z.string(),
                                        value: z.union([z.string(), z.number(), z.boolean()]),
                                        config: z.object({
                                            type: z.enum(['all', 'stream', 'array', 'count']),
                                            limit: z.number().optional().default(100),
                                            offset: z.number().optional().default(0),
                                            sort: z.string().optional(),
                                            includeArchived: z.boolean().optional().default(false)
                                        }),
                                    }).safeParse(parsed.value.data);
                                    if (!p.success) {
                                        structInstance.log('Error parsing data for fromProperty:', p.error);
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            p.error
                                        );
                                    }
                                    const { property, value, config } = p.data;
                                    const res = await structInstance.fromProperty(property, value, config as any);
                                    const readRes = await read(res);
                                    if (readRes.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            readRes.error
                                        );
                                    }
                                    return this.reply(parsed.value.target, parsed.value.id, 'fromProperty', readRes.value);
                                }
                                case 'from-vhid': {
                                    const structInstance = this.structs.get(struct);
                                    if (!structInstance) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Struct ${struct} not found`)
                                        );
                                    }
                                    const p = z.object({ vhId: z.string(), }).safeParse(parsed.value.data);
                                    if (!p.success) {
                                        structInstance.log('Error parsing data for fromVhId:', p.error);
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            p.error
                                        );
                                    }
                                    const { vhId } = p.data;
                                    const res = await structInstance.fromVhId(vhId);
                                    if (res.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            res.error
                                        );
                                    }
                                    return this.reply(parsed.value.target, parsed.value.id, 'fromVhId', res.value);
                                }
                                case 'get': {
                                    const structInstance = this.structs.get(struct);
                                    if (!structInstance) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Struct ${struct} not found`)
                                        );
                                    }
                                    const p = z.object({
                                        data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
                                        config: z.object({
                                            type: z.enum(['all', 'stream', 'array', 'count']),
                                            limit: z.number().optional().default(100),
                                            offset: z.number().optional().default(0),
                                            sort: z.string().optional(),
                                            includeArchived: z.boolean().optional().default(false)
                                        }),
                                    }).safeParse(parsed.value.data);
                                    if (!p.success) {
                                        structInstance.log('Error parsing data for get:', p.error);
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            p.error
                                        );
                                    }
                                    const res = await structInstance.get(p.data.data, p.data.config as any);
                                    const readRes = await read(res);
                                    if (readRes.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            readRes.error
                                        );
                                    }
                                    return this.reply(parsed.value.target, parsed.value.id, 'get', readRes.value); 
                                }
                                case 'all': {
                                    const structInstance = this.structs.get(struct);
                                    if (!structInstance) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Struct ${struct} not found`)
                                        );
                                    }
                                    const p = z.object({
                                        config: z.object({
                                            type: z.enum(['all', 'stream', 'array', 'count']),
                                            limit: z.number().optional().default(100),
                                            offset: z.number().optional().default(0),
                                            sort: z.string().optional(),
                                            includeArchived: z.boolean().optional().default(false)
                                        }),
                                    }).safeParse(parsed.value.data);
                                    if (!p.success) {
                                        structInstance.log('Error parsing data for all:', p.error);
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            p.error
                                        );
                                    }
                                    const res = await structInstance.all(p.data.config as any);
                                    const readRes = await read(res);
                                    if (readRes.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            readRes.error
                                        );
                                    }
                                    return this.reply(parsed.value.target, parsed.value.id, 'all', readRes.value);
                                }
                                case 'archived': {
                                    const structInstance = this.structs.get(struct);
                                    if (!structInstance) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Struct ${struct} not found`)
                                        );
                                    }
                                    const p = z.object({
                                        config: z.object({
                                            type: z.enum(['all', 'stream', 'array', 'count']),
                                            limit: z.number().optional().default(100),
                                            offset: z.number().optional().default(0),
                                            sort: z.string().optional()
                                        }),
                                    }).safeParse(parsed.value.data);
                                    if (!p.success) {
                                        structInstance.log('Error parsing data for archived:', p.error);
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            p.error
                                        );
                                    }
                                    const res = await structInstance.archived(p.data.config as any);
                                    const readRes = await read(res);
                                    if (readRes.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            readRes.error
                                        );
                                    }
                                    return this.reply(parsed.value.target, parsed.value.id, 'archived', readRes.value);
                                }
                                case 'lifetime-items': {
                                    const structInstance = this.structs.get(struct);
                                    if (!structInstance) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Struct ${struct} not found`)
                                        );
                                    }
                                    const p = z.object({
                                        config: z.object({
                                            type: z.enum(['all', 'stream', 'array', 'count']),
                                            limit: z.number().optional().default(100),
                                            offset: z.number().optional().default(0),
                                            sort: z.string().optional(),
                                            includeArchived: z.boolean().optional().default(false)
                                        }),
                                    }).safeParse(parsed.value.data);
                                    if (!p.success) {
                                        structInstance.log('Error parsing data for lifetime-items:', p.error);
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            p.error
                                        );
                                    }
                                    const res = await structInstance.getLifetimeItems(p.data.config as any);
                                    const readRes = await read(res);
                                    if (readRes.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            readRes.error
                                        );
                                    }
                                    return this.reply(parsed.value.target, parsed.value.id, 'lifetime-items', readRes.value);
                                }
                                case 'get-versions': {
                                    const structInstance = this.structs.get(struct);
                                    if (!structInstance) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Struct ${struct} not found`)
                                        );
                                    }
                                    const p = z.object({ id: z.string(), }).safeParse(parsed.value.data);
                                    if (!p.success) {
                                        structInstance.log('Error parsing data for get-versions:', p.error);
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            p.error
                                        );
                                    }
                                    const { id } = p.data;
                                    const res = await structInstance.fromId(id);
                                    if (res.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            res.error
                                        );
                                    }
                                    if (!res.value) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            new Error(`Item with id ${id} not found`)
                                        );
                                    }
                                    const versions = res.value.getVersions();
                                    const readRes = await read(versions);
                                    if (readRes.isErr()) {
                                        return this.reply(
                                            parsed.value.target,
                                            parsed.value.id,
                                            'error',
                                            readRes.error
                                        );
                                    }
                                    return this.reply(parsed.value.target, parsed.value.id, 'get-versions', readRes.value);
                                }
                            }
                        }
                    });

                    this.em.emit('connect');
                    res();
                });
            });
        });
    }
}

const read = <T extends Blank, N extends string>(
    data: StructStream<T, N> | ResultPromise<StructData<T, N>[] | number | StructData<T, N> | DataVersion<T, N>[] | DataVersion<T, N>>,
) => attemptAsync(async () => {
    if (data instanceof StructStream) {
        return data.await().unwrap().then(d => d.map(d => d.data));
    } else {
        const res = await data.unwrap();
        switch (true) {
            case Array.isArray(res):
                return res.map(d => d.data);
            case typeof res === 'number':
                return res;
            case res instanceof StructData || res instanceof DataVersion:
                return res.data;
            default:
                throw new Error('Unknown data type returned from struct operation');
        }
    }
});