import { Client, Server, StructEvent, type Events } from './tcp';
import { z } from 'zod';
import { EventEmitter } from 'ts-utils/event-emitter';
import { attemptAsync } from 'ts-utils/check';
import { Struct, Structable } from './back-end';
import { Stream } from 'ts-utils/stream';

export type StructEvents<T = unknown> = {
    'archive': { struct: string; timestamp: number; data: { id: string } };
    'build': { struct: string; timestamp: number; data: void; };
    'create': { struct: string; timestamp: number; data: T };
    'delete': { struct: string; timestamp: number; data: { id: string; }};
    'delete-version': { struct: string; timestamp: number; data: { vhId: string; id: string; } };
    'restore': { struct: string; timestamp: number; data: { id: string; } };
    'restore-version': { struct: string; timestamp: number; data: { vhId: string; id: string; } };
    'update': { struct: string; timestamp: number; data: T };
    'query': { struct: string; timestamp: number; data: {
        qid: string;
        type: keyof QueryTypes;
        args: QueryTypes[keyof QueryTypes];
    } }

    // response, no timestamp
    'query-data': T;
};

export type QueryTypes = {
    'all': void;
    'fromId': { id: string; };
    'fromProperty': { property: string; value: string; };
    'versions': { id: string; };
    'fromUniverse': { universe: string; };
    'archived': void;
}


export class ServerAPI {
    private readonly emitter = new EventEmitter<StructEvents>();

    public readonly on = this.emitter.on.bind(this.emitter);
    public readonly off = this.emitter.off.bind(this.emitter);
    public readonly once = this.emitter.once.bind(this.emitter);
    private readonly emit = this.emitter.emit.bind(this.emitter);

    constructor(
        public readonly server: Server
    ) {}

    public async init(check: (apiKey: string, struct: string, event: keyof StructEvents) => Promise<boolean> | boolean) {
        return attemptAsync(async () => {
            this.server.on('struct', async (payload) => {
                if (!await check(payload.apiKey, payload.struct, payload.event)) {
                    return console.error('Unauthorized');
                }
                try {
                    const parsed = payload.data;
                    switch (payload.event) {
                        case 'archive':
                            this.emit('archive', {
                                ...payload,
                                data: z.object({
                                    id: z.string(),
                                }).parse(parsed),
                            });
                            break;
                        case 'restore':
                            this.emit('restore', {
                                ...payload,
                                data: z.object({
                                    id: z.string(),
                                }).parse(parsed),
                            });
                            break;
                        case 'delete':
                            this.emit('delete', {
                                ...payload,
                                data: z.object({
                                    id: z.string(),
                                }).parse(parsed),
                            });
                            break;
                        case 'delete-version':
                            this.emit('delete-version', {
                                ...payload,
                                data: z.object({
                                    id: z.string(),
                                    vhId: z.string(),
                                }).parse(parsed),
                            });
                            break;
                        case 'restore-version':
                            this.emit('restore-version', {
                                ...payload,
                                data: z.object({
                                    id: z.string(),
                                    vhId: z.string(),
                                }).parse(parsed),
                            });
                            break;
                        case 'update':
                            this.emit('update', {
                                ...payload,
                                data: parsed,
                            });
                            break;
                        case 'create':
                            this.emit('create', {
                                ...payload,
                                data: parsed,
                            });
                            break;
                    }
                } catch (error) {
                    console.error(error);
                }
            });
        });
    }

    async send<T extends keyof StructEvents>(struct: string, event: T, data: unknown) {
        this.server.send('struct', {
            data: data,
            event: event,
            struct,
        });
    }
    private structEmitters: Map<string, EventEmitter<StructEvents<unknown>>> = new Map();

    createEmitter<T = unknown>(name: string) {
        const em = new EventEmitter<StructEvents<T>>();
        if (!!this.structEmitters.get(name)) {
            throw new Error(`Emitter for struct ${name} already exists`);
        }
        this.structEmitters.set(name, em as any);
        return em;
    }
}


export class ClientAPI {
    constructor(
        public readonly client: Client,
        public readonly apiKey: string
    ) {
    }

    public async init() {
        return attemptAsync(async () => {
            this.client.on('event', (payload) => {
                try {
                    if (payload.event === 'struct') {
                        const packet = z.object({
                            struct: z.string(),
                            event: z.string(),
                            data: z.string(),
                        }).parse(payload.data) as {
                            struct: string;
                            event: keyof StructEvents;
                            data: string;
                        };
                        const em = this.structEmitters.get(packet.struct);
                        if (!em) return;

                        const parsed = JSON.parse(packet.data);

                        switch (packet.event) {
                            case 'archive':
                            case 'delete':
                            case 'restore':
                                em.emit(packet.event, {
                                    struct: packet.struct,
                                    timestamp: payload.timestamp,
                                    data: z.object({
                                        id: z.string(),
                                    }).parse(parsed),
                                });
                                break;
                            case 'delete-version':
                            case 'restore-version':
                                em.emit(packet.event, {
                                    struct: packet.struct,
                                    timestamp: payload.timestamp,
                                    data: z.object({
                                        id: z.string(),
                                        vhId: z.string(),
                                    }
                                    ).parse(parsed),
                                });
                                break;
                            case 'create':
                                em.emit(packet.event, {
                                    struct: packet.struct,
                                    timestamp: payload.timestamp,
                                    data: parsed, // will be validated
                                });
                                break;
                            case 'update':
                                em.emit(packet.event, {
                                    struct: packet.struct,
                                    timestamp: payload.timestamp,
                                    data: {
                                        ...z.record(z.any()).parse(parsed),
                                        id: z.string().parse(parsed?.id),
                                    }
                                });
                                break;
                        }
                    }
                } catch (error) {
                    console.error(error);
                }
            });
        });
    }

    // listen<T extends keyof Events>(event: T, cb: (data: {data: Events[T]; timestamp: number;}) => void, zod?: z.ZodType<Events[T]>) {
    // }

    async send<T extends keyof StructEvents>(struct: string, event: T, data: unknown) {
        this.client.send('struct', {
            data: data,
            event: event,
            struct,
        });
    }

    private readonly structEmitters = new Map<string, EventEmitter<StructEvents<unknown>>> ();

    createEmitter<T = unknown>(name: string) {
        const em = new EventEmitter<StructEvents<T>>();
        if (this.structEmitters.has(name)) {
            return this.structEmitters.get(name) as EventEmitter<StructEvents<T>>;
        }
        this.structEmitters.set(name, em as any);
        return em;
    }

    query<T extends keyof QueryTypes, S extends Struct>(struct: S, type: T, args: QueryTypes[T]) {
        return this.client.query(struct.name, type, args) as Stream<Structable<S['data']['structure']>>;
    }
}
