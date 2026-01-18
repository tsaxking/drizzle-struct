/* eslint-disable @typescript-eslint/no-explicit-any */
import { connect, Channel, ConsumeMessage } from 'amqplib';
import type { Struct, Blank, StructData } from './back-end';

/**
 * Struct event for message queue
 *
 * @export
 * @typedef {StructEvent}
 * @template T
 * @template Name
 */
export interface StructEvent<T extends Blank, Name extends string> {
	type: 'create' | 'update' | 'delete' | 'archive' | 'restore';
	struct: Name;
	data: StructData<T, Name>;
	timestamp: number;
	source: string;
	metadata?: Record<string, any>;
}

/**
 * Message queue configuration
 *
 * @export
 * @typedef {MessageQueueConfig}
 */
export interface MessageQueueConfig {
	amqpUrl: string;
	serviceName: string;
	durable?: boolean;
}

/**
 * Bridges struct events to a message queue
 *
 * @export
 * @class MessageQueueBridge
 * @typedef {MessageQueueBridge}
 * @template T
 * @template Name
 */
export class MessageQueueBridge<T extends Blank, Name extends string> {
	private connection?: any;
	private channel?: Channel;
	private exchangeName = 'struct_events';
	private queueName: string;

	/**
	 * Creates an instance of MessageQueueBridge.
	 *
	 * @constructor
	 * @param {Struct<T, Name>} struct
	 * @param {MessageQueueConfig} config
	 */
	constructor(
		private struct: Struct<T, Name>,
		private config: MessageQueueConfig
	) {
		this.queueName = `${config.serviceName}.${struct.name}`;
	}

	/**
	 * Connects to the message queue
	 *
	 * @async
	 * @returns {Promise<void>}
	 */
	async connect(): Promise<void> {
		this.connection = await connect(this.config.amqpUrl);
		this.channel = await this.connection!.createChannel();

		await this.channel!.assertExchange(this.exchangeName, 'topic', {
			durable: this.config.durable ?? true
		});

		await this.channel!.assertQueue(this.queueName, {
			durable: this.config.durable ?? true,
			arguments: {
				'x-message-ttl': 86400000,
				'x-max-length': 10000
			}
		});

		await this.channel!.bindQueue(this.queueName, this.exchangeName, `${this.struct.name}.*`);

		this.setupListeners();
	}

	/**
	 * Sets up event listeners on the struct
	 *
	 * @private
	 */
	private setupListeners(): void {
		this.struct.on('create', (data: any) => {
			this.publish('create', data);
		});

		this.struct.on('update', ({ to }: any) => {
			this.publish('update', to);
		});

		this.struct.on('delete', (data: any) => {
			this.publish('delete', data);
		});

		this.struct.on('archive', (data: any) => {
			this.publish('archive', data);
		});

		this.struct.on('restore', (data: any) => {
			this.publish('restore', data);
		});
	}

	/**
	 * Publishes an event to the message queue
	 *
	 * @private
	 * @async
	 * @param {StructEvent<T, Name>['type']} type
	 * @param {StructData<T, Name>} data
	 * @returns {Promise<void>}
	 */
	private async publish(
		type: StructEvent<T, Name>['type'],
		data: StructData<T, Name>
	): Promise<void> {
		if (!this.channel) throw new Error('Channel not initialized');

		const event: StructEvent<T, Name> = {
			type,
			struct: this.struct.name,
			data,
			timestamp: Date.now(),
			source: this.config.serviceName
		};

		const routingKey = `${this.struct.name}.${type}`;

		this.channel.publish(
			this.exchangeName,
			routingKey,
			Buffer.from(JSON.stringify(event, this.serializer)),
			{
				persistent: true,
				contentType: 'application/json',
				timestamp: event.timestamp,
				headers: {
					source: this.config.serviceName,
					struct: this.struct.name
				}
			}
		);

		this.struct.log('Published event:', routingKey);
	}

	/**
	 * Consumes events from the message queue
	 *
	 * @async
	 * @param {(event: StructEvent<T, Name>) => Promise<void>} handler
	 * @param {?{ prefetch?: number; routingPattern?: string }} [options]
	 * @returns {Promise<void>}
	 */
	async consume(
		handler: (event: StructEvent<T, Name>) => Promise<void>,
		options?: {
			prefetch?: number;
			routingPattern?: string;
		}
	): Promise<void> {
		if (!this.channel) throw new Error('Channel not initialized');

		await this.channel.prefetch(options?.prefetch ?? 10);

		if (options?.routingPattern) {
			await this.channel.bindQueue(this.queueName, this.exchangeName, options.routingPattern);
		}

		await this.channel.consume(
			this.queueName,
			async (msg: ConsumeMessage | null) => {
				if (!msg) return;

				try {
					const event: StructEvent<T, Name> = JSON.parse(
						msg.content.toString(),
						this.deserializer
					);

					if (event.source === this.config.serviceName) {
						this.channel!.ack(msg);
						return;
					}

					await handler(event);
					this.channel!.ack(msg);
				} catch (error) {
					this.struct.log('Error processing message:', error);
					this.channel!.nack(msg, false, false);
				}
			},
			{ noAck: false }
		);
	}

	/**
	 * Sets up a dead letter queue
	 *
	 * @async
	 * @returns {Promise<void>}
	 */
	async setupDLQ(): Promise<void> {
		if (!this.channel) throw new Error('Channel not initialized');

		const dlqName = `${this.queueName}.dlq`;

		await this.channel.assertQueue(dlqName, {
			durable: true
		});

		await this.channel.assertQueue(this.queueName, {
			durable: true,
			arguments: {
				'x-dead-letter-exchange': this.exchangeName,
				'x-dead-letter-routing-key': `${this.struct.name}.dlq`
			}
		});

		await this.channel.bindQueue(dlqName, this.exchangeName, `${this.struct.name}.dlq`);
	}

	/**
	 * JSON serializer for dates
	 *
	 * @private
	 * @param {string} key
	 * @param {any} value
	 * @returns {*}
	 */
	private serializer(key: string, value: any) {
		if (value instanceof Date) {
			return { __type: 'Date', value: value.toISOString() };
		}
		return value;
	}

	/**
	 * JSON deserializer for dates
	 *
	 * @private
	 * @param {string} key
	 * @param {any} value
	 * @returns {*}
	 */
	private deserializer(key: string, value: any) {
		if (value && value.__type === 'Date') {
			return new Date(value.value);
		}
		return value;
	}

	/**
	 * Closes the connection
	 *
	 * @async
	 * @returns {Promise<void>}
	 */
	async close(): Promise<void> {
		await this.channel?.close();
		await this.connection?.close();
	}
}
