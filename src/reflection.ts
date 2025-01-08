import http from 'http';
import express from 'express';
import { Blank, Struct, StructData, StructStream } from './back-end';
import { EventEmitter } from 'ts-utils/event-emitter';
import { z } from 'zod';
import { decode, encode } from 'ts-utils/text';
import { attempt, attemptAsync, resolveAll, type Result } from 'ts-utils/check';
import { Stream } from 'ts-utils/stream';
import { Loop } from 'ts-utils/loop';

const { Server: HTTPServer } = http;

class APIError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'APIError';
    }
}

type SseStream = ReadableStreamDefaultController<string>;

let currentId: number | undefined;
const nextId = async () => attemptAsync(async () => {
    if (currentId !== undefined) return currentId++;

    let id = -1;

    const { CachedEvents } = await import('./cached-events');
    await CachedEvents.Events.all(true).pipe(e => {
        if (e.data.eventId > id) {
            id = e.data.eventId;
        }
    });

    currentId = id + 1;
    return currentId;
});

export class Connection {
    private buffer: string[] = []; // Buffer for pending messages
    private isPaused = false; // Indicates if the connection is paused
    private readonly maxBufferSize = 100; // Maximum allowed buffer size
    private readonly heartbeatIntervalMs = 30_000; // Interval to send heartbeats
    private readonly heartbeatTimeoutMs = 60_000; // Timeout to detect stale connections
    private lastHeartbeat: number = Date.now();
    private heartbeatTimer: NodeJS.Timeout | undefined;

    constructor(
        public readonly apiKey: string,
        public readonly server: Server,
        public req: express.Response,
    ) {
        // Start the heartbeat mechanism
        this.startHeartbeat();
    }

    async send(event: string, data: unknown) {
        return attemptAsync(async () => {
            const { CachedEvents } = await import('./cached-events');

            const id = (await nextId()).unwrap();
            const timestamp = Date.now();
            const message = `data: ${encode(JSON.stringify({
                event,
                payload: data,
                timestamp,
                id,
            }))}\n\n`;

            // Add message to buffer if paused, or try sending directly
            this.enqueueMessage(message);

            // Save the event in the database
            (await CachedEvents.Events.new({
                payload: JSON.stringify(data),
                timestamp,
                eventId: id,
                event,
                apiKey: this.apiKey,
                tries: 1,
            })).unwrap();

            return id;
        });
    }

    private enqueueMessage(message: string) {
        if (this.isPaused) {
            this.buffer.push(message);

            // If buffer exceeds max size, drop old messages
            if (this.buffer.length > this.maxBufferSize) {
                console.warn(`Buffer overflow for API key: ${this.apiKey}, dropping oldest message.`);
                this.buffer.shift();
            }

            return;
        }

        try {
            this.req.write(message);
        } catch (err) {
            console.error(`Failed to send message, buffering instead. Error: ${err}`);
            this.isPaused = true;
            this.buffer.push(message);
        }
    }

    private flushBuffer() {
        while (this.buffer.length > 0 && !this.isPaused) {
            const message = this.buffer.shift();
            try {
                this.req.write(message!);
            } catch (err) {
                console.error(`Error while flushing buffer: ${err}`);
                this.isPaused = true;
                this.buffer.unshift(message!); // Re-add the message to the buffer
                return;
            }
        }

        if (this.buffer.length === 0) {
            console.log(`Buffer flushed for API key: ${this.apiKey}`);
        }
    }

    resume() {
        this.isPaused = false;
        this.flushBuffer();
    }

    private startHeartbeat() {
        this.heartbeatTimer = setInterval(() => {
            const now = Date.now();
            if (now - this.lastHeartbeat > this.heartbeatTimeoutMs) {
                console.warn(`Connection timeout for API key: ${this.apiKey}`);
                this.close();
                return;
            }

            this.sendHeartbeat();
        }, this.heartbeatIntervalMs);
    }

    private sendHeartbeat() {
        this.enqueueMessage(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);
    }

    ack(id: number) {
        return attemptAsync(async () => {
            const { CachedEvents } = await import('./cached-events');
            CachedEvents.Events.fromProperty('eventId', id, true).pipe(e => e.delete());
        });
    }

    close() {
        return attempt(() => {
            if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); // Stop heartbeat timer
            this.req.end(); // End the SSE stream
            console.log(`Connection closed for API key: ${this.apiKey}`);
        });
    }

    updateHeartbeat() {
        this.lastHeartbeat = Date.now();
    }
}




type StructEvent<T extends Blank = Blank> = {
    'create': { data: T, timestamp: number },
    'update': { data: T, timestamp: number },
    'delete': { id: string, timestamp: number },
    'delete-version': { id: string, vhId: number, timestamp: number },
    'restore-version': { id: string, vhId: number, timestamp: number },
    'archive': { id: string, timestamp: number },
    'restore': { id: string, timestamp: number },
    'set-attributes': { id: string, attributes: string[], timestamp: number },
    'set-universes': { id: string, universes: string[], timestamp: number },
};

type QueryType = {
    'all': {},
    'from-id': { id: string },
    'from-ids': { ids: string[] },
    'from-property': { property: string, value: any },
    'from-universe': { universe: string },
    'archived': {},
    'versions': { id: string },
}

type QueryResponse<T extends Blank, Name extends string> = {
    'all': Stream<StructData<T, Name>>,
    'from-id': StructData<T, Name> | undefined,
    'from-ids': Stream<StructData<T, Name>>,
    'from-property': Stream<StructData<T, Name>>,
    'from-universe': Stream<StructData<T, Name>>,
    'archived': Stream<StructData<T, Name>>,
    'versions': Stream<StructData<T, Name>>,
};

export class Server {
    public readonly connections = new Map<string, Connection>();

    private readonly structEmitters = new Map<string, EventEmitter<StructEvent>>();

    private readonly app = express();
    private readonly server = new HTTPServer(this.app);

    constructor(
        public readonly port: number, 
        public readonly checkAPI: (key: string) => boolean | Promise<boolean>,
        public readonly checkEvent: (event: {
            apiKey: string;
            event: keyof StructEvent;
            data: Omit<StructEvent[keyof StructEvent], 'timestamp'>;
            timestamp: number;
            struct: string;
        }) => boolean | Promise<boolean>,
    ) {
        this.app.use(express.json());

        this.app.use(async (req, res, next) => {
            try {
                const key = req.headers['x-api-key'] as string;
                if (!key) {
                    res.status(401).send('Unauthorized');
                    return;
                }

                const result = await this.checkAPI(key);
                if (!result) {
                    res.status(403).send('Forbidden');
                    return;
                }
                next();

            } catch (error) {
                console.error(error);
                res.status(500).send('Internal server error');
            }
        });

        this.app.post('/ping', (_, res) => {
            res.status(200).send('pong');
        });

        this.app.post('/struct', async (req, res) => {
            try {
                const structEvent = z.object({
                    event: z.enum(['create', 'update', 'delete', 'delete-version', 'restore-version', 'archive', 'restore', 'set-attributes', 'set-universes']),
                    payload: z.object({
                        struct: z.string(),
                        data: z.any(),
                    }),
                    timestamp: z.number(),
                });

                const { event, timestamp, payload: { data, struct } } = structEvent.parse(req.body);
                const apiKey = req.headers['x-api-key'] as string;

                const result = await this.handleStructEvent(apiKey, { event, timestamp, payload: { data, struct } });
                res.status(result.status).send(result.message);
            } catch (error) {
                console.error(error);
                res.status(500).send('Internal server error');
            }
        });

        this.app.post('/batch', async (req, res) => {
            try {
                const structEvent = z.array(z.object({
                    id: z.number(),
                    event: z.enum(['create', 'update', 'delete', 'delete-version', 'restore-version', 'archive', 'restore', 'set-attributes', 'set-universes']),
                    payload: z.object({
                        struct: z.string(),
                        data: z.any(),
                    }),
                    timestamp: z.number(),
                }));

                const events = structEvent.parse(req.body);
                const apiKey = req.headers['x-api-key'] as string;

                for (const event of events) {
                    const result = await this.handleStructEvent(apiKey, event);
                    if (result.status !== 200) {
                        res.status(result.status).send(result.message);
                        return;
                    }
                }

                res.status(200).send('Events processed successfully');
            } catch (error) {
                console.error(error);
                res.status(500).send('Internal server error');
            }
        });

        this.app.post('/query', async (req, res) => {
            try {
                const { struct, query, args } = z.object({
                    struct: z.string(),
                    query: z.enum(['all', 'from-id', 'from-ids', 'from-property', 'from-universe', 'archived', 'versions']),
                    args: z.any(),
                }).parse(req.body);

                const s = Struct.structs.get(struct);
                if (!s) {
                    res.status(404).send('Struct not found');
                    return;
                }

                const stream = (stream: StructStream) => {
                    res.setHeader('Content-Type', 'application/json');
                    res.status(200).send(new ReadableStream({
                        start(controller) {
                            const onData = (data: StructData) => {
                                controller.enqueue(encode(JSON.stringify(data)));
                            };
                            stream.on('data', onData);
                            stream.once('end', () => {
                                controller.enqueue('end');
                                controller.close();
                                stream.off('data', onData);
                            });
                        }
                    }));
                };

                const send = (data: unknown) => {
                    res.setHeader('Content-Type', 'application/json');
                    res.status(200).json(data);
                }

                switch (query) {
                    case 'all':
                        stream(s.all(true));
                        break;
                    case 'archived':
                        stream(s.archived(true));
                        break;
                    case 'from-property': {
                        const { property, value } = z.object({
                            property: z.string(),
                            value: z.any(),
                        }).parse(args);
                        stream(s.fromProperty(property, value, true));
                    }
                        break;
                    case 'from-universe': {
                        const { universe } = z.object({
                            universe: z.string(),
                        }).parse(args);
                        stream(s.fromUniverse(universe, true));
                    }
                    break;
                    case 'versions': {
                        const { id } = z.object({
                            id: z.string(),
                        }).parse(args);
                        const data = (await s.fromId(id)).unwrap();
                        if (!data) {
                            res.status(404).send('Data not found');
                            return;
                        }
                        send((await data.getVersions()).unwrap());
                    }
                    break;
                    case 'from-id': {
                        const { id } = z.object({
                            id: z.string(),
                        }).parse(args);
                        const data = (await s.fromId(id)).unwrap();
                        if (!data) {
                            res.status(404).send('Data not found');
                            return;
                        }
                        send(data);
                    } break;
                    case 'from-ids': {
                        const { ids } = z.object({
                            ids: z.array(z.string()),
                        }).parse(args);
                        stream(s.fromIds(ids, true));
                    }
                    break;
                    default:
                        res.status(400).send('Invalid query');
                        break;
                }
            } catch (error) {
                console.error(error);
                res.status(500).send('Internal server error');
            }
        });

        this.app.get('/sse', (req, res) => {
            const apiKey = req.headers['x-api-key'] as string;
            
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            const self = this;

            res.write(`data: ${JSON.stringify({ message: 'Connected to SSE' })}\n\n`);

            const connection = new Connection(apiKey, this, res);
            this.connections.set(apiKey, connection);

            req.on('close', () => {
                console.log(`Connection closed for API key: ${apiKey}`);
                this.connections.delete(apiKey);
                connection.close();
            });
        });

        this.app.post('/ack', async (req, res) => {
            try {
                
            } catch (error) {
                console.error(error);
                res.status(500).send('Internal server error');
            }
        });
    }

    async handleStructEvent(apiKey: string, structEvent: any) {
        const { event, timestamp, payload: { data, struct } } = structEvent;
    
        // Check event authorization
        if (!await this.checkEvent({ apiKey, event, data, timestamp, struct })) {
            return { status: 403, message: 'Forbidden' };
        }
    
        const emitter = this.structEmitters.get(struct);
        if (!emitter) {
            return { status: 404, message: 'Emitter not found' };
        }
    
        // Switch case to handle different events
        switch (event) {
            case 'create': {
                emitter.emit('create', { data, timestamp });
                break;
            }
            case 'update': {
                emitter.emit('update', { data, timestamp });
                break;
            }
            case 'delete': {
                emitter.emit('delete', { id: data, timestamp });
                break;
            }
            case 'archive': {
                emitter.emit('archive', { id: data, timestamp });
                break;
            }
            case 'delete-version': {
                emitter.emit('delete-version', { id: data.id, vhId: data.vhId, timestamp });
                break;
            }
            case 'restore': {
                emitter.emit('restore', { id: data, timestamp });
                break;
            }
            case 'restore-version': {
                emitter.emit('restore-version', { id: data.id, vhId: data.vhId, timestamp });
                break;
            }
            case 'set-attributes': {
                emitter.emit('set-attributes', { id: data.id, attributes: data.attributes, timestamp });
                break;
            }
            case 'set-universes': {
                emitter.emit('set-universes', { id: data.id, universes: data.universes, timestamp });
                break;
            }
            default: {
                return { status: 400, message: 'Invalid event' };
            }
        }
    
        return { status: 200, message: 'Event processed successfully' };
    }
    public start(cb: () => void) {
        this.server.listen(this.port, cb);
    }

    public getEmitter<T extends Blank, Name extends string>(struct: Struct<T, Name>) {
        const emitter = this.structEmitters.get(struct.name);
        if (!emitter) {
            const newEmitter = new EventEmitter<StructEvent<T>>();
            this.structEmitters.set(struct.name, newEmitter);
            return newEmitter;
        }
        return emitter as EventEmitter<StructEvent<T>>;
    }

    async send<T extends Blank, Name extends string>(struct: Struct<T, Name>, event: keyof StructEvent, data: Omit<StructEvent[keyof StructEvent], 'timestamp'>) {
        return resolveAll(await Promise.all(Array.from(this.connections.values()).map(async c => attemptAsync(async () => {
            if (await this.checkEvent({
                apiKey: c.apiKey,
                event,
                data,
                timestamp: Date.now(),
                struct: struct.name,
            })) {
                c.send(event, {
                    struct: struct.name,
                    data,
                });
            }
        }))));
    }
}

export class Client {
    connected = false;

    constructor(
        public readonly apikey: string,
        public readonly host: string,
        public readonly port: number,
        public readonly https: boolean,
    ) {}

    private readonly structEmitters = new Map<string, EventEmitter<StructEvent>>();

    send<T extends Blank, Name extends string>(struct: Struct<T, Name>, event: keyof StructEvent<T>, data: Omit<StructEvent<T>[keyof StructEvent<T>], 'timestamp'>) {
        return attemptAsync(async () => {
            const { CachedEvents } = await import('./cached-events');
            const id = (await nextId()).unwrap();
            const timestamp = Date.now();
            const payload = {
                struct: struct.name,
                data,
            };
            (await CachedEvents.Events.new({
                payload: JSON.stringify(payload),
                timestamp,
                eventId: id,
                event,
                apiKey: this.apikey,
                tries: 1,
            })).unwrap();
            return this.sendEvent({
                id,
                event,
                payload,
                timestamp,
            });
        });
    }

    private sendEvent(event: {
        id: number;
        event: keyof StructEvent;
        payload: {
            struct: string;
            data: Omit<StructEvent[keyof StructEvent], 'timestamp'>;
        },
        timestamp: number;
    }) {
        return attemptAsync(async () => {
            if (!this.connected) {
                throw new Error('Not connected');
            }
            return fetch(`${this.url}/struct`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apikey,
                },
                body: JSON.stringify(event),
            });
        });
    }

    query<T extends Blank, N extends string, Q extends keyof QueryType>(struct: Struct<T, N>, type: Q, args: QueryType[Q]): Promise<Result<QueryResponse<T, N>[Q], Error>> {
        return attemptAsync(async () => {
            return fetch(`${this.url}/query`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apikey,
                },
                body: JSON.stringify({
                    struct: struct.name,
                    query: type,
                    args,
                }),
            }).then(async res => {
                if (!res.ok) {
                    throw new APIError(await res.text());
                }

                if (type === 'from-id') {
                    return struct.Generator(await res.json());
                }

                const s = new Stream<StructData<T, N>>();

                const reader = res.body?.getReader();
                if (!reader) throw new APIError('No reader');

                let buffer = '';
                let done = false;

                while (!done) {
                    const { value, done: d } = await reader.read();
                    if (value) {
                        buffer += value;
                    }
                    done = d;

                    const parts = buffer.split('\n\n');
                    buffer = parts.pop() || '';

                    for (const part of parts) {
                        if (part === 'end') break;
                        try {
                            s.add(JSON.parse(decode(part)));
                        } catch (error) {
                            console.error(error);
                        }
                    }
                }

                return s;
            });
        }) as any;
    }

    ping() {
        return attemptAsync(async () => {
            return fetch(`${this.url}/ping`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apikey,
                },
            });
        });
    }

    private startLoop() {
        return attemptAsync(async () => {
            const { CachedEvents } = await import('./cached-events');
            const loop = new Loop(async () => {
                const res = await this.ping();
                if (res.isOk() && res.value.ok) {
                    this.connected = true;
                } else {
                    this.connected = false;
                }
    
                try {
                    CachedEvents.Events.all(true).pipe(e => {
                        // Under 1 minute
                        if (e.data.timestamp + 60_000 > Date.now()) return;
                        e.update({
                            tries: e.data.tries + 1,
                        });

                        this.addToBatch({
                            id: e.data.eventId,
                            event: e.data.event as keyof StructEvent,
                            payload: JSON.parse(e.data.payload),
                            timestamp: e.data.timestamp,
                        });
                        // this.sendEvent({
                        //     id: e.data.eventId,
                        //     event: e.data.event as keyof StructEvent,
                        //     payload: JSON.parse(e.data.payload),
                        //     timestamp: e.data.timestamp,
                        // });
                    });
                } catch (error) {
                    console.error(error);
                }
            }, 60_000); // Ping every minute
    
            return loop.start();
        });
    }

    private batch: { id: number, event: keyof StructEvent, payload: { struct: string, data: Omit<StructEvent[keyof StructEvent], 'timestamp'> }, timestamp: number }[] = [];
    private batchTimeout: NodeJS.Timeout | undefined;
    private addToBatch(event: {
        id: number;
        event: keyof StructEvent;
        payload: {
            struct: string;
            data: Omit<StructEvent[keyof StructEvent], 'timestamp'>;
        },
        timestamp: number;
    }) {
        this.batch.push(event);
        if (this.batch.length === 10) return this.sendBatch();
        if (this.batchTimeout) clearTimeout(this.batchTimeout);
        this.batchTimeout = setTimeout(() => {
            this.sendBatch();
        }, 1000);
    }

    private sendBatch() {
        if (!this.batch.length) return;
        const batch = this.batch;
        this.batch = [];
        return attemptAsync(async () => {
            if (!this.connected) {
                throw new Error('Not connected');
            }
            return fetch(`${this.url}/batch`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apikey,
                },
                body: JSON.stringify(batch),
            });
        });
    }

    get url() {
        return `${this.https ? 'https' : 'http'}://${this.host}:${this.port}`;
    }

    public getEmitter<T extends Blank, Name extends string>(struct: Struct<T, Name>) {
        const emitter = this.structEmitters.get(struct.name);
        if (!emitter) {
            const newEmitter = new EventEmitter<StructEvent<T>>();
            this.structEmitters.set(struct.name, newEmitter);
            return newEmitter;
        }
        return emitter as EventEmitter<StructEvent<T>>;
    }

    public start() {
        return attemptAsync(async () => {
            const reconnectDelay = 1000; // Initial reconnection delay (1 second)
            let reconnectAttempts = 0;
    
            const connect = async () => {
                return new Promise<void>((resolve, reject) => {
                    const req = http.request({
                        hostname: this.host,
                        port: this.port,
                        path: '/sse',
                        method: 'GET',
                        headers: {
                            'x-api-key': this.apikey,
                            'Accept': 'text/event-stream',
                        }
                    }, res => {
                        if (res.statusCode !== 200) {
                            return reject(new APIError('API Server Error'));
                        }
    
                        res.on('data', (chunk: Buffer) => {
                            try {
                                const data = chunk.toString().trim();
                                if (data.startsWith('data: ') && data.endsWith('\n\n')) {
                                    const unsafe = JSON.parse(decode(data.slice(6, -2)));
                                    const parsed = z.object({
                                        event: z.enum(['create', 'update', 'delete', 'delete-version', 'restore-version', 'archive', 'restore', 'set-attributes', 'set-universes']),
                                        payload: z.object({
                                            struct: z.string(),
                                            data: z.any(),
                                        }),
                                        timestamp: z.number(),
                                        id: z.number(),
                                    }).parse(unsafe);
    
                                    const em = this.structEmitters.get(parsed.payload.struct);
                                    if (em) {
                                        switch (parsed.event) {
                                            case 'create': {
                                                em.emit('create', { data: parsed.payload.data, timestamp: parsed.timestamp });
                                            } break;
                                            case 'update': {
                                                em.emit('update', { data: parsed.payload.data, timestamp: parsed.timestamp });
                                            } break;
                                            case 'delete': {
                                                em.emit('delete', { id: parsed.payload.data, timestamp: parsed.timestamp });
                                            } break;
                                            case 'archive': {
                                                em.emit('archive', { id: parsed.payload.data, timestamp: parsed.timestamp });
                                            } break;
                                            case 'delete-version': {
                                                em.emit('delete-version', { id: parsed.payload.data.id, vhId: parsed.payload.data.vhId, timestamp: parsed.timestamp });
                                            } break;
                                            case 'restore': {
                                                em.emit('restore', { id: parsed.payload.data, timestamp: parsed.timestamp });
                                            } break;
                                            case 'restore-version': {
                                                em.emit('restore-version', { id: parsed.payload.data.id, vhId: parsed.payload.data.vhId, timestamp: parsed.timestamp });
                                            } break;
                                            case 'set-attributes': {
                                                em.emit('set-attributes', { id: parsed.payload.data.id, attributes: parsed.payload.data.attributes, timestamp: parsed.timestamp });
                                            } break;
                                            case 'set-universes': {
                                                em.emit('set-universes', { id: parsed.payload.data.id, universes: parsed.payload.data.universes, timestamp: parsed.timestamp });
                                            } break;
                                        }
                                    }
    
                                    this.ack(parsed.id);
                                }
                            } catch (error) {
                                console.error(error);
                            }
                        });
    
                        res.on('error', (err) => {
                            reject(err);
                        });
    
                        res.on('end', () => {
                            // In case of an end of stream (unexpected)
                            reject(new APIError('Stream ended unexpectedly'));
                        });
    
                        resolve(); // Successfully connected
                    });
    
                    req.on('error', reject); // In case of request errors
                    req.end();
                });
            };
    
            // Try to connect with exponential backoff
            const attemptConnection = async () => {
                try {
                    await connect();
                    reconnectAttempts = 0; // Reset on successful connection
                } catch (error) {
                    console.error('SSE connection failed:', error);
                    reconnectAttempts++;
                    const delay = Math.min(reconnectDelay * (2 ** reconnectAttempts), 30000); // Exponential backoff with max delay
                    console.log(`Reconnecting in ${delay / 1000}s...`);
                    setTimeout(attemptConnection, delay);
                }
            };
    
            await attemptConnection(); // Start connection

            this.startLoop();
        });
    }

    private ack(id: number) {
        return attemptAsync(async () => {
            return fetch(`${this.url}/ack`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apikey,
                },
                body: JSON.stringify({ id }),
            });
        });
    }
}