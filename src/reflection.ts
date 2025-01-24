import http from 'http';
import express from 'express';
import { Blank, globalCols, Struct, Structable, StructData, StructStream } from './back-end';
import { EventEmitter } from 'ts-utils/event-emitter';
import { z } from 'zod';
import { decode, encode } from 'ts-utils/text';
import { attempt, attemptAsync, resolveAll, type Result } from 'ts-utils/check';
import { Stream } from 'ts-utils/stream';
import { Loop } from 'ts-utils/loop';
import fs from 'fs';
import axios from 'axios';

const { Server: HTTPServer } = http;

/**
 * Error class for API errors
 *
 * @class APIError
 * @typedef {APIError}
 * @extends {Error}
 */
class APIError extends Error {
    /**
     * Creates an instance of APIError.
     *
     * @constructor
     * @param {string} message 
     */
    constructor(message: string) {
        super(message);
        this.name = 'APIError';
    }
}

/**
 * Cached current ID for optimization
 *
 * @type {(number | undefined)}
 */
let currentId: number | undefined;
/**
 * Gets the next available id for an event
 *
 * @async
 * @returns {unknown} 
 */
const nextId = async () => attemptAsync(async () => {
    if (currentId !== undefined) return currentId++;

    let id = -1;

    const { CachedEvents } = await import('./cached-events');
    await CachedEvents.Events.all({
        type: 'stream'
    }).pipe((e: any) => {
        if (e.data.eventId > id) {
            id = e.data.eventId;
        }
    });

    currentId = id + 1;
    return currentId;
});

/**
 * Connection between two servers
 *
 * @export
 * @class Connection
 * @typedef {Connection}
 */
export class Connection {
    /**
     * Buffer of data to prevent memory leaks on the socket
     *
     * @private
     * @type {string[]}
     */
    private buffer: string[] = [];
    /**
     * If the connection is draining and not accepting new data
     *
     * @private
     * @type {boolean}
     */
    private isPaused = false;
    /**
     * Maximum buffer size before dropping old messages
     *
     * @private
     * @readonly
     * @type {100}
     */
    private readonly maxBufferSize = 100;
    /**
     * Maximum time between heartbeats before closing the connection
     *
     * @private
     * @readonly
     * @type {30000}
     */
    private readonly heartbeatIntervalMs = 30_000;
    /**
     * Base time for the heartbeat timeout
     *
     * @private
     * @readonly
     * @type {60000}
     */
    private readonly heartbeatTimeoutMs = 60_000;
    /**
     * Last time the heartbeat was sent
     *
     * @private
     * @type {number}
     */
    private lastHeartbeat: number = Date.now();
    /**
     * Heartbeat timer
     *
     * @private
     * @type {(NodeJS.Timeout | undefined)}
     */
    private heartbeatTimer: NodeJS.Timeout | undefined;

    /**
     * Creates an instance of Connection.
     *
     * @constructor
     * @param {string} apiKey The API key for the connection
     * @param {Server} server The server instance
     * @param {express.Response} req The request object
     */
    constructor(
        public readonly apiKey: string,
        public readonly server: Server,
        public req: express.Response,
    ) {
        // Start the heartbeat mechanism
        this.startHeartbeat();

        this.req.on('drain', () => this.resume());
    }

    /**
     * Send an event to the connection
     *
     * @async
     * @param {string} event 
     * @param {unknown} data 
     * @returns {unknown} 
     */
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

    /**
     * Write a message to the connection
     *
     * @private
     * @param {string} message 
     */
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

    /**
     * Drains the buffer to the connection if not paused
     *
     * @private
     */
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

    /** 
     * Drains the buffer and resumes the connection
     */
    resume() {
        this.isPaused = false;
        this.flushBuffer();
    }

    /**
     * Start the heartbeat mechanism
     *
     * @private
     */
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

    /**
     * Send a heartbeat to the connection
     *
     * @private
     */
    private sendHeartbeat() {
        this.enqueueMessage(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);
    }

    /**
     * Acknowledge an event
     *
     * @param {number} id 
     * @returns {*} 
     */
    ack(id: number) {
        return attemptAsync(async () => {
            const { CachedEvents } = await import('./cached-events');
            CachedEvents.Events.fromProperty('eventId', id, true).pipe((e: any) => e.delete());
        });
    }

    /**
     * Close the connection
     *
     * @returns {*} 
     */
    close() {
        return attempt(() => {
            if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); // Stop heartbeat timer
            this.req.end(); // End the SSE stream
            console.log(`Connection closed for API key: ${this.apiKey}`);
        });
    }

    /** 
     * Update the heartbeat timestamp
    */
    updateHeartbeat() {
        this.lastHeartbeat = Date.now();
    }
}




/**
 * Struct events and their payload types
 *
 * @typedef {StructEvent}
 * @template {Blank} [T=Blank] 
 */
type StructEvent<T extends Blank = Blank> = {
    'create': { data: Structable<T>, timestamp: number },
    'update': { data: Structable<T>, timestamp: number },
    'delete': { id: string, timestamp: number },
    'delete-version': { id: string, vhId: number, timestamp: number },
    'restore-version': { id: string, vhId: number, timestamp: number },
    'archive': { id: string, timestamp: number },
    'restore': { id: string, timestamp: number },
    'set-attributes': { id: string, attributes: string[], timestamp: number },
    'set-universes': { id: string, universes: string[], timestamp: number },
};

/**
 * Query types and their arguments
 *
 * @export
 * @typedef {QueryType}
 */
export type QueryType = {
    'all': {};
    'from-id': { id: string };
    // 'from-ids': { ids: string[] };
    'from-property': { property: string, value: any };
    'from-universe': { universe: string };
    'archived': {};
    'versions': { id: string };
    // 'get': Record<string, unknown>;
}

/**
 * Query response types
 *
 * @typedef {QueryResponse}
 * @template {Blank} T 
 */
type QueryResponse<T extends Blank> = {
    'all': Stream<Structable<T & typeof globalCols>>;
    'from-id': Structable<T> | undefined;
    // 'from-ids': Stream<Structable<T & typeof globalCols>>;
    'from-property': Stream<Structable<T & typeof globalCols>>;
    'from-universe': Stream<Structable<T & typeof globalCols>>;
    'archived': Stream<Structable<T & typeof globalCols>>;
    'versions': Stream<Structable<T & typeof globalCols>>;
    // 'get': Stream<Structable<T & typeof globalCols>>;
};

type ServerConfig = {
    port: number;
    checkEvent: (event: {
        apiKey: string;
        event: keyof StructEvent;
        data: Omit<StructEvent[keyof StructEvent], 'timestamp'>;
        timestamp: number;
        struct: string;
    }) => boolean | Promise<boolean>;
    checkAPI: (key: string) => boolean | Promise<boolean>;
    logFile?: string;
    fileStreamDir: string;
};

/**
 * API Server
 *
 * @export
 * @class Server
 * @typedef {Server}
 */
export class Server {
    /**
     * All active connections
     *
     * @public
     * @readonly
     * @type {*}
     */
    public readonly connections = new Map<string, Connection>();

    /**
     * Cached struct emitters
     *
     * @private
     * @readonly
     * @type {*}
     */
    private readonly structEmitters = new Map<string, EventEmitter<StructEvent>>();

    /**
     * Express app instance
     *
     * @private
     * @readonly
     * @type {*}
     */
    private readonly app = express();
    /**
     * The server instance
     *
     * @private
     * @readonly
     * @type {*}
     */
    private readonly server = new HTTPServer(this.app);

    /**
     * Creates an instance of Server.
     *
     * @constructor
     * @param {number} port 
     * @param {(key: string) => boolean | Promise<boolean>} checkAPI 
     * @param {(event: {
     *             apiKey: string;
     *             event: keyof StructEvent;
     *             data: Omit<StructEvent[keyof StructEvent], 'timestamp'>;
     *             timestamp: number;
     *             struct: string;
     *         }) => boolean | Promise<boolean>} checkEvent 
     * @param {string} logFile Output log file
     */
    constructor(
        // public readonly port: number, 
        // public readonly checkAPI: (key: string) => boolean | Promise<boolean>,
        // public readonly checkEvent: (event: {
        //     apiKey: string;
        //     event: keyof StructEvent;
        //     data: Omit<StructEvent[keyof StructEvent], 'timestamp'>;
        //     timestamp: number;
        //     struct: string;
        // }) => boolean | Promise<boolean>,
        // public readonly logFile?: string,
        public readonly config: ServerConfig,
    ) {
        this.app.use(express.json());

        this.app.use(async (req, res, next) => {
            try {
                const key = req.headers['x-api-key'] as string;
                if (!key) {
                    res.status(401).send('Unauthorized');
                    return;
                }

                const result = await this.config.checkAPI(key);
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
                    query: z.enum(['all', 'from-id', 'from-ids', 'from-property', 'from-universe', 'archived', 'versions', 'get']),
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
                        stream(s.all({
                            type: 'stream',
                        }));
                        break;
                    case 'archived':
                        stream(s.archived({
                            type: 'stream',
                        }));
                        break;
                    case 'from-property': {
                        const { property, value } = z.object({
                            property: z.string(),
                            value: z.any(),
                        }).parse(args);
                        stream(s.fromProperty(property as any, value, {
                            type: 'stream',
                        }));
                    }
                        break;
                    case 'from-universe': {
                        const { universe } = z.object({
                            universe: z.string(),
                        }).parse(args);
                        stream(s.fromUniverse(universe, {
                            type: 'stream',
                        }));
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
                    // case 'from-ids': {
                    //     const { ids } = z.object({
                    //         ids: z.array(z.string()),
                    //     }).parse(args);
                    //     stream(s.fromIds(ids, true));
                    // }
                    // break;
                    // case 'get': {
                    //     const data = s.get(args, true, true);
                    //     stream(data);
                    // }
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

        this.app.get('/file/:fileId', async (req, res) => {
            const filePath = `${this.config.fileStreamDir}/${req.params.fileId}`;
            res.setHeader('Content-Disposition', 'attachment; filename="file.txt"');
            res.setHeader('Content-Type', 'application/octet-stream');
            try {
                const streamer = fs.createReadStream(filePath);
                streamer.pipe(res);
                streamer.on('end', () => {
                    try {
                        res.end();
                    } catch (error) {
                        console.error(error);
                    }
                });

                streamer.on('error', (err) => {
                    console.error(err);
                    res.status(500).send('Internal server error');
                });

                res.on('error', (err) => {
                    console.error(err);
                    res.status(500).send('Internal server error');
                });
            } catch (error) {
                console.error(error);
                res.status(500).send('Internal server error');
            }
        });

        this.app.post('/file/:fileId', async (req, res) => {
            // saving the file
            const filePath = `${this.config.fileStreamDir}/${req.params.fileId}`;
            // check if the file exists

            if (fs.existsSync(filePath)) {
                res.status(409).send('File already exists');
                return;
            }

            const streamer = fs.createWriteStream(filePath);
            req.pipe(streamer);

            streamer.on('finish', () => {
                res.status(200).send('File uploaded successfully');
            });

            streamer.on('error', (err) => {
                console.error(err);
                res.status(500).send('Internal server error');
            });

            req.on('error', (err) => {
                console.error(err);
                res.status(500).send('Internal server error');
            });
        });
    }

    /**
     * Handler for struct events, separated for batching or streaming
     *
     * @async
     * @param {string} apiKey 
     * @param {*} structEvent 
     * @returns {unknown} 
     */
    async handleStructEvent(apiKey: string, structEvent: any) {
        const { event, timestamp, payload: { data, struct } } = structEvent;
    
        // Check event authorization
        if (!await this.config.checkEvent({ apiKey, event, data, timestamp, struct })) {
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
    /**
     * Stars the server
     *
     * @public
     * @param {() => void} cb 
     * @returns {void) => void} 
     */
    public start(cb?: () => void) {
        this.server.listen(this.config.port, cb);
    }

    /**
     * Retrieves an emitter for a struct
     *
     * @public
     * @template {Blank} T 
     * @template {string} Name 
     * @param {Struct<T, Name>} struct 
     * @returns {*} 
     */
    public getEmitter<T extends Blank, Name extends string>(struct: Struct<T, Name>) {
        const emitter = this.structEmitters.get(struct.name);
        if (!emitter) {
            const newEmitter = new EventEmitter<StructEvent<T>>();
            this.structEmitters.set(struct.name, newEmitter);
            return newEmitter;
        }
        return emitter as EventEmitter<StructEvent<T>>;
    }

    /**
     * Sends an event to all connections
     *
     * @async
     * @template {Blank} T 
     * @template {string} Name 
     * @param {Struct<T, Name>} struct 
     * @param {keyof StructEvent} event 
     * @param {Omit<StructEvent[keyof StructEvent], 'timestamp'>} data 
     * @returns 
     */
    async send<T extends Blank, Name extends string>(struct: Struct<T, Name>, event: keyof StructEvent, data: Omit<StructEvent[keyof StructEvent], 'timestamp'>) {
        return resolveAll(await Promise.all(Array.from(this.connections.values()).map(async c => attemptAsync(async () => {
            if (await this.config.checkEvent({
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

type ClientConfig = {
    port: number;
    host: string;
    apikey: string;
    https: boolean;
    logFile?: string;
    fileStreamDir: string;
};

/**
 * API Client
 *
 * @export
 * @class Client
 * @typedef {Client}
 */
export class Client {
    /**
     * History of queries, used for rate limiting
     *
     * @public
     * @readonly
     * @type {*}
     */
    public readonly queryHistory = new Map<string, Map<keyof QueryType, number>>();
    /**
     * Last time the client disconnected
     *
     * @public
     * @type {*}
     */
    public lastDisconnect = Date.now();
    /**
     * If the client is connected to the server
     *
     * @public
     * @type {boolean}
     */
    public connected = false;

    /**
     * Creates an instance of Client.
     *
     * @constructor
     * @param {string} apikey API key for the client
     * @param {string} host Hostname of the server
     * @param {number} port Port of the server
     * @param {boolean} https If the server uses HTTPS
     * @param {string} logFile Output log file
     */
    constructor(
        // public readonly apikey: string,
        // public readonly host: string,
        // public readonly port: number,
        // public readonly https: boolean,
        // public readonly logFile: string,
        public readonly config: ClientConfig,
    ) {}

    /**
     * Cached struct emitters
     *
     * @private
     * @readonly
     * @type {*}
     */
    private readonly structEmitters = new Map<string, EventEmitter<StructEvent>>();

    /**
     * Sends an event to the server
     *
     * @template {Blank} T 
     * @template {string} Name 
     * @param {Struct<T, Name>} struct 
     * @param {keyof StructEvent<T>} event 
     * @param {Omit<StructEvent<T>[keyof StructEvent<T>], 'timestamp'>} data 
     * @returns {*} 
     */
    send<T extends Blank, Name extends string>(struct: Struct<T, Name>, event: keyof StructEvent<T>, data: Omit<StructEvent<T>[keyof StructEvent<T>], 'timestamp'>) {
        return attemptAsync<unknown>(async () => {
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
                apiKey: this.config.apikey,
                tries: 1,
            })).unwrap();
            return (await this.sendEvent({
                id,
                event,
                payload,
                timestamp,
            })).unwrap();
        });
    }

    /**
     * Actual send event, separated for caching
     *
     * @private
     * @param {{
     *         id: number;
     *         event: keyof StructEvent;
     *         payload: {
     *             struct: string;
     *             data: Omit<StructEvent[keyof StructEvent], 'timestamp'>;
     *         },
     *         timestamp: number;
     *     }} event 
     * @returns 
     */
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
                    'x-api-key': this.config.apikey,
                },
                body: JSON.stringify(event),
            }).then(r => r.json());
        });
    }

    /**
     * Queries the server for data
     *
     * @template {Blank} T 
     * @template {string} N 
     * @template {keyof QueryType} Q 
     * @param {Struct<T, N>} struct 
     * @param {Q} type 
     * @param {QueryType[Q]} args 
     * @returns {Promise<Result<QueryResponse<T>[Q], Error>>} 
     */
    query<T extends Blank, N extends string, Q extends keyof QueryType>(struct: Struct<T, N>, type: Q, args: QueryType[Q]): Promise<Result<QueryResponse<T>[Q], Error>> {
        return attemptAsync(async () => {
            log(this.config.logFile, {
                event: 'query',
                type: 'info',
                message: `Querying ${struct.name} with type ${type}`,
            });
            {
                const s = this.queryHistory.get(struct.name) || new Map<keyof QueryType, number>();
                s.set(type, Date.now());
                this.queryHistory.set(struct.name, s);
            }
            return fetch(`${this.url}/query`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.config.apikey,
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

    /**
     * Pings the server to check connection
     *
     * @returns {*} 
     */
    ping() {
        return attemptAsync(async () => {
            return fetch(`${this.url}/ping`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.config.apikey,
                },
            });
        });
    }

    /**
     * Starts pinging loop to emit connect/disconnect events and handle batch updates
     *
     * @private
     * @returns {*} 
     */
    private startLoop() { 
        return attemptAsync(async () => {
            const { CachedEvents } = await import('./cached-events');
            const loop = new Loop(async () => {
                const res = await this.ping();
                if (res.isOk() && res.value.ok) {
                    if (!this.connected) {
                        log(this.config.logFile, {
                            event: 'connection',
                            type: 'info',
                            message: 'Connected to API server',
                        });
                    }
                    this.connected = true;
                } else {
                    if (this.connected) {
                        log(this.config.logFile, {
                            event: 'connection',
                            type: 'warn',
                            message: 'Disconnected from API server',
                        });
                        this.lastDisconnect = Date.now();
                    }
                    this.connected = false;
                }
    
                try {
                    CachedEvents.Events.all({
                        type: 'stream',
                    }).pipe((e: any) => {
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

    /**
     * Batch update events to the server
     *
     * @private
     * @type {{ id: number, event: keyof StructEvent, payload: { struct: string, data: Omit<StructEvent[keyof StructEvent], 'timestamp'> }, timestamp: number }[]}
     */
    private batch: { id: number, event: keyof StructEvent, payload: { struct: string, data: Omit<StructEvent[keyof StructEvent], 'timestamp'> }, timestamp: number }[] = [];
    /**
     * Timeout for batching events
     *
     * @private
     * @type {(NodeJS.Timeout | undefined)}
     */
    private batchTimeout: NodeJS.Timeout | undefined;
    /**
     * Adds a new event to the batch, and sends if full
     *
     * @private
     * @param {{
     *         id: number;
     *         event: keyof StructEvent;
     *         payload: {
     *             struct: string;
     *             data: Omit<StructEvent[keyof StructEvent], 'timestamp'>;
     *         },
     *         timestamp: number;
     *     }} event 
     * @returns 
     */
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

    /**
     * Sends a batch of events to the server
     *
     * @private
     * @returns {*} 
     */
    private sendBatch() {
        if (!this.batch.length) return;
        const batch = this.batch;
        this.batch = [];
        return attemptAsync(async () => {
            if (!this.connected) {
                throw new Error('Not connected');
            }
            log(this.config.logFile, {
                event: 'batch',
                type: 'info',
                message: `Sending batch of ${batch.length} events`,
            });
            return fetch(`${this.url}/batch`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.config.apikey,
                },
                body: JSON.stringify(batch),
            });
        });
    }

    /**
     * Url of the server
     *
     * @readonly
     * @type {string}
     */
    get url() {
        return `${this.config.https ? 'https' : 'http'}://${this.config.host}:${this.config.port}`;
    }

    /**
     * Retrieves an emitter for a struct
     *
     * @public
     * @template {Blank} T 
     * @template {string} Name 
     * @param {Struct<T, Name>} struct 
     * @returns {*} 
     */
    public getEmitter<T extends Blank, Name extends string>(struct: Struct<T, Name>) {
        const emitter = this.structEmitters.get(struct.name);
        if (!emitter) {
            const newEmitter = new EventEmitter<StructEvent<T>>();
            this.structEmitters.set(struct.name, newEmitter);
            return newEmitter;
        }
        return emitter as EventEmitter<StructEvent<T>>;
    }

    /**
     * Starts the client
     *
     * @public
     * @returns {*} 
     */
    public start() {
        return attemptAsync(async () => {
            const reconnectDelay = 1000; // Initial reconnection delay (1 second)
            let reconnectAttempts = 0;
    
            const connect = async () => {
                return new Promise<void>((resolve, reject) => {
                    const req = http.request({
                        hostname: this.config.host,
                        port: this.config.port,
                        path: '/sse',
                        method: 'GET',
                        headers: {
                            'x-api-key': this.config.apikey,
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

    /**
     * Acknowledge an event
     *
     * @private
     * @param {number} id 
     * @returns {*} 
     */
    private ack(id: number) {
        return attemptAsync(async () => {
            return fetch(`${this.url}/ack`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.config.apikey,
                },
                body: JSON.stringify({ id }),
            });
        });
    }

    /**
     * Retrieves the last time a query was made
     *
     * @param {string} struct 
     * @param {keyof QueryType} type 
     * @returns {*} 
     */
    getLastRead(struct: string, type: keyof QueryType) {
        const s = this.queryHistory.get(struct);
        if (!s) return undefined;
        return s.get(type);
    }

    getFile(fileId: string) {
        return attemptAsync(() => {
            return new Promise<void>((res, rej) => {
                axios({
                    url: `${this.url}/file/${fileId}`,
                    headers: {
                        'x-api-key': this.config.apikey,
                    },
                    method: 'GET',
                    responseType: 'stream',
                }).then(response => {
                    const writeStream = fs.createWriteStream(`${this.config.fileStreamDir}/${fileId}`);
                    response.data.pipe(writeStream);

                    writeStream.on('finish', res);
                    writeStream.on('error', rej);
                }).catch(rej);
            });
        });
    }

    saveFile(fileId: string) {
        return attemptAsync(() => {
            return new Promise<void>((res, rej) => {
                const readStream = fs.createReadStream(`${this.config.fileStreamDir}/${fileId}`);
                axios({
                    url: `${this.url}/file/${fileId}`,
                    headers: {
                        'x-api-key': this.config.apikey,
                    },
                    method: 'POST',
                    data: readStream,
                }).then((response) => {
                    if (response.status >= 400) rej(new Error('Failed to save file'));
                    else res();
                }).catch(rej);
            });
        });
    }
}

/**
 * Logs an event to a file
 *
 * @param {string} logFile 
 * @param {{
 *     event: string;
 *     type: 'info' | 'warn' | 'error';
 *     message: string;
 * }} data 
 * @returns {*} 
 */
const log = (logFile: string | undefined, data: {
    event: string;
    type: 'info' | 'warn' | 'error';
    message: string;
}) => {
    return attemptAsync(async () => {
        if (!logFile) return;
        const timestamp = Date.now();
        const line = `${timestamp} [${data.event}] ${data.type.toUpperCase()}: ${data.message}\n`;
        return fs.promises.appendFile(logFile, line);
    });
};