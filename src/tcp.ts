/* eslint-disable @typescript-eslint/no-explicit-any */
import net from 'net';
import { z } from 'zod';
import { EventEmitter } from 'ts-utils/event-emitter';
import { attemptAsync } from 'ts-utils/check';

type StructEvent = {
    struct: string;
    event: string;
    data: string;
};

export type Events = {
    connect: string;
    disconnect: void;
    struct: StructEvent;
};

export type ClientEvents = {
    connect: undefined;
    disconnect: void;
    struct: StructEvent;
}



class Connection {
    private readonly emitter = new EventEmitter();

    private readonly buffer: {
        event: string;
        data: unknown;
        timestamp: number;
        id: number;  // Add id to track events
    }[] = [];

    private doBuffer = false;
    private _connected = false;
    private currentId = 0; // Start from 0 for event id's

    constructor(
        public socket: net.Socket,
        public readonly apiKey: string,
        public readonly server: Server,
    ) {
        this.socket.on('drain', () => {
            this.flushBuffer();
        });

        this.setupSocketListeners();
    }

    send(event: string, data: unknown, timestamp: number) {
        const id = this.currentId++;
        const eventPayload = {
            event,
            data,
            timestamp,
            id,
        };

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

    private handleAcknowledgment(eventId: number) {
        // Acknowledge with "hey I got this: id"
        const ackMessage = JSON.stringify({ event: 'ack', data: `hey I got this: ${eventId}`, timestamp: Date.now() });
        this.socket.write(ackMessage);
    }

    close() {
        this.socket.destroy();
        this.emitter.emit('disconnect', undefined);
    }

    listen<T = unknown>(event: string, listener: (data: {
        data: T;
        timestamp: number;
    }) => void, zod?: z.ZodType<T>) {
        const run = (data: {
            data: T;
            timestamp: number;
        }) => {
            // try {
            return attemptAsync(async () => {
                if (zod) {
                    const typed = zod.parse(data.data);
                    listener({
                        data: typed,
                        timestamp: data.timestamp,
                    });
                } else {
                    if (data === undefined) listener(data);
                    else console.log('Did not pass zod into an event handler where data is being used.');
                }
            });
            // } catch (e) {
            //     console.error(e);
            // }
        }

        this.emitter.on(event, run as (data: unknown) => void);

        return () => this.emitter.off(event, run as (data: unknown) => void);
    }

    private setupSocketListeners() {
        this.socket.on('connect', () => this.setConnected(true));
        this.socket.on('drain', () => this.flushBuffer());
        this.socket.on('close', () => this.setConnected(false));
        this.socket.on('end', () => this.setConnected(false));
        this.socket.on('error', (err) => {
            console.error('Socket error:', err);
            this.setConnected(false);
        });
    }

    private setConnected(state: boolean) {
        if (this._connected !== state) {
            this._connected = state;
            const event = state ? 'connect' : 'disconnect';
            this.emitter.emit(event, undefined);
            console.log(`Connection state updated: ${state ? 'Connected' : 'Disconnected'}`);
        }
    }

    get connected() {
        return this._connected;
    }
}



export type ServerEvents = {
    'new-connection': string;
    'closed-connection': string;
};

export class Server {
    private readonly connections = new Map<string, Connection>();

    public readonly server: net.Server;
    private readonly emitter = new EventEmitter<ServerEvents>();
    public readonly on = this.emitter.on.bind(this.emitter);
    public readonly off = this.emitter.off.bind(this.emitter);
    private readonly emit = this.emitter.emit.bind(this.emitter);
    public readonly once = this.emitter.once.bind(this.emitter);

    constructor(public readonly address: string, public readonly port: number) {
        this.server = net.createServer((socket) => {
            let connection: Connection | undefined;
            let numTries = 0; // Keep track of the retry attempts
            const maxRetries = 5; // Maximum number of retries
            const maxBackoffDelay = 10000; // Maximum backoff delay in milliseconds (10 seconds)
            // const buffer: {
            //     event: string;
            //     data?: unknown;
            // }[] = [];

            const reconnect = () => {
                if (connection) connection['_connected'] = false;

                if (numTries >= maxRetries) {
                    // If we've reached the max retries, stop retrying
                    socket.off('close', reconnect);
                    socket.off('error', reconnect);
                    connection?.close();
                    console.log('Max retries reached. Giving up.');
                    return;
                }

                numTries++;

                // Calculate the backoff delay (exponential backoff)
                const backoffDelay = Math.min(Math.pow(2, numTries) * 100, maxBackoffDelay);
                const jitter = Math.random() * 1000; // Optional jitter to avoid synchronized retries

                const finalDelay = backoffDelay + jitter; // Final delay with jitter

                console.log(`Attempt ${numTries} failed. Retrying in ${finalDelay.toFixed(0)}ms...`);

                // Set a timeout to retry after the calculated backoff delay
                setTimeout(() => {
                    console.log(`Reconnecting after ${finalDelay.toFixed(0)}ms...`);
                    socket.connect({ port: this.port, host: this.address });
                }, finalDelay);
            };

            socket.on('data', async (data) => {
                try {
                    const json = JSON.parse(data.toString()) as unknown;
                    const typed = z.object({
                        event: z.string(),
                        data: z.unknown()
                    }).parse(json);

                    if (typed.event === 'connect') {
                        const apiKey = z.string().parse(typed.data);
                        // const valid = (await Webhook.get(apiKey)).unwrap();
                        // if (!valid) {
                        //     socket.write(JSON.stringify({ event: 'error', data: 'Invalid API key' }));
                        //     socket.destroy();
                        //     return;
                        // }
                        // Check if a connection already exists
                        connection = this.connections.get(apiKey);
                        if (connection) {
                            console.log('Reusing existing connection for API key:', apiKey);
                            connection.socket.destroy(); // Clean up old socket
                            connection.socket = socket; // Replace with new socket
                            connection['_connected'] = true;
                        } else {
                            connection = this.addConnection(socket, apiKey);
                        }
                    }
                } catch (error) {
                    console.error(error);
                }
            });

            // Handle socket closure or error events
            socket.on('close', reconnect);
            socket.on('error', reconnect);
        });
    }

    addConnection(socket: net.Socket, apiKey: string) {
        const has = this.connections.get(apiKey);
        if (has) return has;
        const c = new Connection(socket, apiKey, this);
        c['emitter'].emit('connect', apiKey);
        this.connections.set(apiKey, c);
        c.listen('disconnect', () => this.connections.delete(apiKey));
        return c;
    }

    close() {
        for (const connection of this.connections.values()) {
            connection.close();
        }
        this.server.close();
    }

    start() {
        this.server.listen(this.port, this.address);
    }

    sendTo(apiKey: string, event: string, data: unknown, timestamp: number) {
        const connection = this.connections.get(apiKey);
        if (!connection) return false;
        connection.send(event, data, timestamp);
        return true;
    }

    private readonly listenCache = new Map<string, {
        event: string;
        listener: (data: unknown) => void;
        zod?: z.ZodType<unknown>;
    }[]>();

    listenTo<T = unknown>(apiKey: string, event: string, listener: (data: { data: T; timestamp: number; }) => void, zod?: z.ZodType<T>) {
        const connection = this.connections.get(apiKey);
        if (!connection) {
            const cache = this.listenCache.get(apiKey) ?? [];
            cache.push({ 
                event, 
                listener: listener as any, 
                zod,
            });
            this.listenCache.set(apiKey, cache);
            return;
        }
        connection.listen(event, listener, zod);
        return true;
    }

    getState(apiKey: string) {
        const connection = this.connections.get(apiKey);
        if (!connection) return 'no-connection';
        return connection.connected ? 'connected' : 'disconnected';
    }
}


export class Client {
    private readonly emitter = new EventEmitter();
    private readonly buffer: {
        event: string;
        data: unknown;
        timestamp: number;
        id: number;
    }[] = [];

    private doBuffer = false;
    private _connected = false;
    private currentId = 0;
    private socket?: net.Socket;

    constructor(
        private readonly serverAddress: string,
        private readonly serverPort: number,
        private readonly apiKey: string
    ) {}

    async connect() {
        return attemptAsync(async () => {
            this.socket = net.createConnection({ host: this.serverAddress, port: this.serverPort }, () => {
                console.log('Client connected to server');
                this._connected = true;
                this.emitter.emit('connect', undefined);
                this.send('connect', this.apiKey, Date.now());
            });

            this.socket.on('data', (data) => this.handleData(data));
            this.socket.on('end', () => this.handleDisconnect());
            this.socket.on('close', () => this.handleDisconnect());
            this.socket.on('error', (err) => console.error('Client socket error:', err));

            this.socket.on('close', () => {
                this._connected = false;
                this.emitter.emit('disconnect', undefined);
                console.log('Disconnected from server, attempting to reconnect...');
                setInterval(() => this.connect(), 5000); // Retry every 5 seconds
            });
        });
    }

    send(event: string, data: unknown, timestamp: number) {
        const id = this.currentId++;
        const eventPayload = {
            event,
            data,
            timestamp,
            id,
        };

        if (this.doBuffer) {
            this.buffer.push(eventPayload);
            return false;
        }

        if (this.socket) {
            this.doBuffer = !this.socket.write(JSON.stringify(eventPayload));
        }

        if (this.doBuffer) {
            console.log('Client socket is experiencing backpressure');
        }

        return !this.doBuffer;
    }

    private handleData(data: Buffer) {
        try {
            const json = JSON.parse(data.toString());
            const typed = z.object({
                event: z.string(),
                data: z.unknown(),
                timestamp: z.number(),
            }).parse(json);

            if (typed.event === 'ack') {
                // Handle acknowledgment for a particular id
                console.log(`Acknowledgment received: ${typed.data}`);
                const str = z.string().parse(typed.data);
                this.removeFromBuffer(str); // Remove acknowledged event from buffer
            } else {
                this.emitter.emit(typed.event as keyof Events, typed.data as any);
            }
        } catch (error) {
            console.error('Error parsing data:', error);
        }
    }

    private removeFromBuffer(ackMessage: string) {
        const ackId = ackMessage.split(': ')[1]; // Extract the id from "hey I got this: id"
        const index = this.buffer.findIndex(event => event.id.toString() === ackId);
        if (index !== -1) {
            this.buffer.splice(index, 1); // Remove the acknowledged event from buffer
        }
    }

    private handleDisconnect() {
        this._connected = false;
        console.log('Client disconnected');
        this.emitter.emit('disconnect', undefined);
    }

    listen<T = unknown>(event: string, listener: (data: { data: T, timestamp: number }) => void, zod?: z.ZodType<T>) {
        const run = (data: { data: T, timestamp: number }) => {
            try {
                if (zod) {
                    const typed = zod.parse(data.data);
                    listener({
                        data: typed,
                        timestamp: data.timestamp,
                    });
                } else {
                    if (data === undefined) listener(data);
                    else console.log('Did not pass zod into an event handler where data is being used.', event, data);
                }
            } catch (e) {
                console.error(e);
            }
        };

        this.emitter.on(event, run as (data: unknown) => void);

        return () => this.emitter.off(event, run as (data: unknown) => void);
    }

    get connected() {
        return this._connected;
    }

    close() {
        this.socket?.destroy();
        this._connected = false;
    }
}
