/* eslint-disable @typescript-eslint/no-explicit-any */
import net from 'net';
import { z, ZodParsedType } from 'zod';
import { EventEmitter } from 'ts-utils/event-emitter';
import { attemptAsync } from 'ts-utils/check';
import { CachedEvents } from './cached-events';
import { Loop } from 'ts-utils/loop';
import { StructEvents } from './api';
export type StructEvent = {
    struct: string;
    event: string;
    data: string;
};

export type Events = {
    i_am: string;
    struct: StructEvent;
    test: { test: string };
};

type EventPacket<K extends keyof Events = keyof Events> = {
    event: K;
    data: Events[K];
    id: number;
    timestamp: number;
};


type GlobalEvents = {
    event: EventPacket;
    connect: void;
    disconnect: void;
    ack: number;
};

// This is a wrapper to handle saving and lossless transmission of events over unstable connections
class Event<K extends keyof Events = keyof Events> {
    public tries = 0;
    constructor(
        public readonly event: K, 
        public readonly data: Events[K], 
        public readonly timestamp: number, 
        public readonly id: number
    ) {}


    save() {
        return CachedEvents.Events.new({
            timestamp: this.timestamp,
            eventId: this.id,
            event: this.event,
            data: JSON.stringify(this.data),
        });
    }

    delete() {
        return attemptAsync(async () => {
            const events = (await CachedEvents.Events.fromProperty('eventId', this.id, false)).unwrap();
            for (const e of events) (await e.delete()).unwrap();
        });
    }
}

// This only handles acknowledgement and retransmission
class TCPEventHandler {
    private readonly emitter = new EventEmitter<GlobalEvents>();
    public readonly on = this.emitter.on.bind(this.emitter);
    public readonly off = this.emitter.off.bind(this.emitter);
    public readonly once = this.emitter.once.bind(this.emitter);
    private readonly emit = this.emitter.emit.bind(this.emitter);

    public readonly cache = new Map<number, Event>();
    public connected = false;

    public readonly loop = new Loop(async () => {
        for (const event of this.cache.values()) {
            if (event.tries >= 5) {
                this.emit('disconnect', undefined);
            } else {
                event.tries++;
                this.send(event);
            }
        }
    }, 1000 * 10);

    constructor(public readonly destination: TCPSocket) {
        this.loop.start();
        this.on('ack', async (id) => {
            this.cache.delete(id);
            // there should only be one, but it returns an array
            const events = (await CachedEvents.Events.fromProperty('eventId', id, false)).unwrap();
            for (const e of events) e.delete();
        });
        this.on('connect', () => {
            this.connected = true;
        });
        this.on('disconnect', () => {
            this.connected = false;
            this.save();
        });
        this.on('event', async (packet) => {
            const id = await this.getNewId();
            const event = new Event(packet.event, packet.data, Date.now(), id);
            if (this.connected) {
                this.cache.set(id, event);
                event.tries++;
                this.send(event);
            } else {
                event.save();
            }
        });
    }

    private lastId?: number;

    private async getNewId() {
        if (this.lastId !== undefined) return this.lastId++;
        // const last = (await CachedEvents.Events.all(false)).unwrap().sort((a, b) => a.data.eventId - b.data.eventId).pop();
        // this.lastId = last?.data.eventId ?? -1;
        // return this.lastId++;
        let last = 0;
        await CachedEvents.Events.all(true).pipe(event => {
            if (event.data.eventId > last) {
                last = event.data.eventId;
            }
        }, 1000 * 10);
        this.lastId = last;
        return this.lastId++;
    }

    private purge() {
        for (const id of this.cache.keys()) {
            this.cache.delete(id);
        }
    }

    private save() {
        for (const event of this.cache.values()) {
            event.save();
        }
    }

    private send(event: Event) {
        this.destination.write(JSON.stringify({
            event: event.event,
            data: event.data,
            timestamp: event.timestamp,
            id: event.id,
        }));
    }

    public write(event: string, data: unknown) {
        this.emit('event', { event, data } as any);
    }

    public ack(id: number) {
        this.emit('ack', id);
    }

    public shutdown() {
        this.loop.stop();
        this.save();
        this.purge();
    }

    public sendAck(id: number) {
        // this.destination.write(JSON.stringify({ event: 'ack', data: id }));
        this.write('ack', id);
    }
}

// This handles backpressure from the socket
class TCPSocket {
    private readonly buffer: string[] = [];
    private doBuffer = false;

    constructor(public readonly socket: net.Socket) {
        socket.on('drain', () => this.flushBuffer());
    }

    write(eventPayload: string) {
        if (this.doBuffer) {
            this.buffer.push(eventPayload);
            return false;
        }

        this.doBuffer = !this.socket.write(JSON.stringify(eventPayload));

        if (this.doBuffer) {
            console.log('Socket is experiencing backpressure');
        }

        return this.doBuffer;
    }

    private flushBuffer() {
        while (this.buffer.length > 0) {
            const event = this.buffer.shift();
            if (!event) break;

            const drained = this.socket.write(JSON.stringify(event));
            if (!drained) {
                this.buffer.unshift(event); 
                break;
            }
        }

        if (this.buffer.length === 0) {
            this.doBuffer = false;
        }
    }
}

// This is a client connection to the server
export class ClientConnection {
    private readonly emitter = new EventEmitter<{
        disconnect: void;
        struct: {
            struct: string;
            event: string;
            data: string;
            timestamp: number;
        }
    }>();
    public readonly on = this.emitter.on.bind(this.emitter);
    public readonly off = this.emitter.off.bind(this.emitter);
    public readonly once = this.emitter.once.bind(this.emitter);
    private readonly emit = this.emitter.emit.bind(this.emitter);

    private readonly handler: TCPEventHandler;

    constructor(
        socket: net.Socket,
        public readonly server: Server
    ) {
        const tcp = new TCPSocket(socket);
        this.handler = new TCPEventHandler(tcp);
        socket.on('data', (data) => {
            try {
                const event = JSON.parse(data.toString());
                const parsed = z.object({
                    event: z.string(),
                    data: z.any(),
                    id: z.number(),
                    timestamp: z.number(),
                }).parse(event);
                if (parsed.event === 'ack') {
                    this.handler.ack(parsed.data);
                    return;
                }
    
                if (parsed.event === 'struct') {
                    const struct = z.object({
                        struct: z.string(),
                        event: z.string(),
                        data: z.string(),
                    }).parse(parsed.data);
                    this.emit('struct', {
                        timestamp: parsed.timestamp,
                        struct: struct.struct,
                        event: struct.event,
                        data: struct.data,
                    });
                }
                this.handler.sendAck(parsed.id);
            } catch (error) {
                console.error(error);
            }
        });
    }

    send<K extends keyof Events>(event: K, data: Events[K]) {
        this.handler.write(event, data);
    }
}

// This is a server that listens for client connections
export class Server {
    private readonly clients = new Map<string, { connection: ClientConnection | null; reconnectAttempts: number }>();
    private readonly emitter = new EventEmitter<Events & {
        client_connected: string; // client key
        client_disconnected: string; // client key
        reconnect_attempt: { key: string; attempt: number; delay: number };
    }>();
    private readonly on = this.emitter.on.bind(this.emitter);
    private readonly off = this.emitter.off.bind(this.emitter);
    private readonly once = this.emitter.once.bind(this.emitter);

    private readonly server: net.Server;
    private maxReconnectDelay = 30000; // 30 seconds
    private baseDelay = 1000; // 1 second
    private maxReconnectAttempts = 5;

    constructor(
        public readonly port: number,
        public readonly host: string,
        private readonly testKey: (key: string) => Promise<boolean> | boolean
    ) {
        this.server = net.createServer((socket) => this.handleNewConnection(socket));
        this.server.listen(this.port, this.host, () => {
            console.log(`Server listening on ${this.host}:${this.port}`);
        });
    }

    private handleNewConnection(socket: net.Socket) {
        const connection = new ClientConnection(socket, this);

        const onClientIdentification = async (key: string) => {
            if (!(await this.testKey(key))) {
                socket.end();
                return;
            }

            if (this.clients.has(key)) {
                // Close any previous connection for this key
                const previous = this.clients.get(key);
                previous?.connection?.off('disconnect', this.handleClientDisconnect(key));
                previous?.connection?.off('i_am', onClientIdentification);
                this.clients.delete(key);
            }

            this.clients.set(key, { connection, reconnectAttempts: 0 });
            connection.off('i_am', onClientIdentification);
            connection.on('disconnect', this.handleClientDisconnect(key));
            this.emitter.emit('client_connected', key);
        };

        connection.on('i_am', onClientIdentification);
    }

    private handleClientDisconnect(key: string) {
        return () => {
            const client = this.clients.get(key);
            if (!client) return;

            this.clients.delete(key);
            this.emitter.emit('client_disconnected', key);
            this.startReconnect(key);
        };
    }

    private startReconnect(key: string) {
        if (!this.clients.has(key)) {
            // Initialize the client for reconnection tracking
            this.clients.set(key, { connection: null, reconnectAttempts: 0 });
        }

        const attemptReconnect = async () => {
            const client = this.clients.get(key);
            if (!client) return;

            if (client.reconnectAttempts >= this.maxReconnectAttempts) {
                console.warn(`Max reconnect attempts reached for client: ${key}`);
                this.clients.delete(key);
                return;
            }

            const { reconnectAttempts } = client;
            const delay = Math.min(
                this.baseDelay * Math.pow(2, reconnectAttempts),
                this.maxReconnectDelay
            );

            client.reconnectAttempts++;
            this.emitter.emit('reconnect_attempt', { key, attempt: reconnectAttempts + 1, delay });

            await new Promise((resolve) => setTimeout(resolve, delay));

            try {
                const socket = net.createConnection(this.port, this.host);
                const connection = new ClientConnection(socket, this);

                connection.on('disconnect', this.handleClientDisconnect(key));

                this.clients.set(key, { connection, reconnectAttempts: 0 });
                this.emitter.emit('client_connected', key);
            } catch (error) {
                console.error(`Reconnect attempt for ${key} failed:`, error);
                attemptReconnect(); // Retry if the connection fails
            }
        };

        attemptReconnect();
    }

    listen<T extends keyof StructEvents>(event: T, cb: (data: { data: string; timestamp: number; }) => void, zod?: z.ZodType<Events[T]>) {

    }
}



// This is the client that will connect to the server
export class Client {
    private readonly emitter = new EventEmitter<{
        connect: void;
        disconnect: void;
        reconnect_attempt: { attempt: number; delay: number };
        reconnect_failed: void; // Emitted after max attempts
        event: EventPacket;
    }>();
    public readonly on = this.emitter.on.bind(this.emitter);
    public readonly off = this.emitter.off.bind(this.emitter);
    public readonly once = this.emitter.once.bind(this.emitter);

    private handler?: TCPEventHandler;
    private reconnectAttempts = 0;
    private maxReconnectDelay = 30000; // 30 seconds
    private baseDelay = 1000; // 1 second
    private maxReconnectAttempts = 5;
    private reconnecting = false;

    constructor(
        public readonly port: number,
        public readonly host: string,
        public readonly apiKey: string
    ) {
        this.connect();
    }

    private connect() {
        const socket = net.createConnection(this.port, this.host);

        const tcp = new TCPSocket(socket);
        this.handler = new TCPEventHandler(tcp);

        socket.on('connect', () => {
            this.reconnectAttempts = 0;
            this.reconnecting = false;
            this.emitter.emit('connect', undefined);
            this.authenticate();
        });

        socket.on('error', (error) => {
            console.error('Socket error:', error);
        });

        socket.on('close', () => {
            this.emitter.emit('disconnect', undefined);
            this.startReconnect();
        });

        socket.on('data', (data) => {
            try {
                const event = JSON.parse(data.toString());
                const parsed = z.object({
                    event: z.string(),
                    data: z.any(),
                    id: z.number(),
                    timestamp: z.number(),
                }).parse(event);
                if (parsed.event === 'ack') {
                    this.handler?.ack(parsed.data);
                    return;
                }

                this.handler?.sendAck(parsed.id);
    
            } catch (error) {
                console.error(error);
            }
        });
    }

    private authenticate() {
        if (this.handler) {
            this.handler.write('i_am', this.apiKey);
        }
    }

    private startReconnect() {
        if (this.reconnecting) return;

        this.reconnecting = true;
        const attemptReconnect = async () => {
            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                console.warn('Max reconnect attempts reached.');
                this.reconnecting = false;
                this.emitter.emit('reconnect_failed', undefined);
                return;
            }

            const delay = Math.min(
                this.baseDelay * Math.pow(2, this.reconnectAttempts),
                this.maxReconnectDelay
            );
            this.reconnectAttempts++;

            this.emitter.emit('reconnect_attempt', {
                attempt: this.reconnectAttempts,
                delay,
            });

            await new Promise((resolve) => setTimeout(resolve, delay));
            this.connect();
        };

        attemptReconnect();
    }

    send<K extends keyof Events>(event: K, data: Events[K]) {
        if (!this.handler) {
            console.warn('No active connection to send events.');
            return;
        }
        this.handler.write(event, data);
    }
}
