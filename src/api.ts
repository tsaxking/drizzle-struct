import { Client, Server, StructEvent, type Events } from './tcp';
import { string, z } from 'zod';
import fs from 'fs';
import path from 'path';
import { lock } from 'proper-lockfile';
import { EventEmitter } from 'ts-utils/event-emitter';
import { attemptAsync } from 'ts-utils/check';


export type StructEvents<T = unknown> = {
    'archive': { timestamp: number; data: { id: string } };
    'build': { timestamp: number; data: { struct: string; } };
    'create': { timestamp: number; data: T };
    'delete': { timestamp: number; data: { id: string; }};
    'delete-version': { timestamp: number; data: { vhId: string; id: string; } };
    'restore': { timestamp: number; data: { id: string; } };
    'restore-version': { timestamp: number; data: { vhId: string; id: string; } };
    'update': { timestamp: number; data: T };
};
export class ServerAPI {
    constructor(
        public readonly server: Server
    ) {
    }

    public async init(structCheck: (apiKey: string, struct: string, event: string) => Promise<boolean> | boolean) {
        return attemptAsync(async () => {
        });
    }

    listen<T extends keyof Events>(event: T, cb: (data: { data: Events[T]; timestamp: number; }) => void, zod?: z.ZodType<Events[T]>) {
    }

    async send<T extends keyof Events>(event: T, data: Events[T]) {
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
            this.client.on('event', (data) => {
                try {
                    if (data.event === 'struct') {
                        const packet = z.object({
                            struct: z.string(),
                            event: z.string(),
                            data: z.string(),
                        }).parse(data.data) as {
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
                                    timestamp: data.timestamp,
                                    data: z.object({
                                        id: z.string(),
                                    }).parse(parsed),
                                });
                                break;
                            case 'delete-version':
                            case 'restore-version':
                                em.emit(packet.event, {
                                    timestamp: data.timestamp,
                                    data: z.object({
                                        id: z.string(),
                                        vhId: z.string(),
                                    }
                                    ).parse(parsed),
                                });
                                break;
                            case 'create':
                                em.emit(packet.event, {
                                    timestamp: data.timestamp,
                                    data: parsed, // will be validated
                                });
                                break;
                            case 'update':
                                em.emit(packet.event, {
                                    timestamp: data.timestamp,
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

    async send<T extends keyof Events>(event: T, data: Events[T]) {
        this.client.send(event, data);
    }

    private structEmitters: Map<string, EventEmitter<StructEvents<unknown>>> = new Map();

    createEmitter<T = unknown>(name: string) {
        const em = new EventEmitter<StructEvents<T>>();
        if (this.structEmitters.has(name)) {
            return this.structEmitters.get(name) as EventEmitter<StructEvents<T>>;
        }
        this.structEmitters.set(name, em as any);
        return em;
    }
}
