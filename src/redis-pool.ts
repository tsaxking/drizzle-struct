/* eslint-disable @typescript-eslint/no-explicit-any */
import { Redis } from 'redis-utils';
import { EventEmitter } from 'events';

/**
 * Redis connection configuration
 *
 * @export
 * @typedef {RedisPoolConfig}
 */
export interface RedisPoolConfig {
	host: string;
	port: number;
	password?: string;
	db?: number;
}

/**
 * Redis connection pool options
 *
 * @export
 * @typedef {RedisPoolOptions}
 */
export interface RedisPoolOptions {
	maxConnectionsPerTarget?: number;
	minConnectionsPerTarget?: number;
	connectionTimeout?: number;
	idleTimeout?: number;
	healthCheckInterval?: number;
}

/**
 * Manages a pool of Redis connections
 *
 * @export
 * @class RedisConnectionPool
 * @typedef {RedisConnectionPool}
 * @template RedisName
 */
export class RedisConnectionPool<RedisName extends string> {
	private connections: Map<string, Redis<RedisName>> = new Map();
	private connectionCounts: Map<string, number> = new Map();
	private maxConnectionsPerTarget: number;
	private minConnectionsPerTarget: number;
	private connectionTimeout: number;
	private idleTimeout: number;
	private healthCheckInterval: number;
	private healthChecker?: NodeJS.Timeout;
	private emitter = new EventEmitter();

	/**
	 * Creates an instance of RedisConnectionPool.
	 *
	 * @constructor
	 * @param {RedisPoolConfig} redisConfig
	 * @param {RedisPoolOptions} [options={}]
	 */
	constructor(
		private redisConfig: RedisPoolConfig,
		options: RedisPoolOptions = {}
	) {
		this.maxConnectionsPerTarget = options.maxConnectionsPerTarget ?? 10;
		this.minConnectionsPerTarget = options.minConnectionsPerTarget ?? 2;
		this.connectionTimeout = options.connectionTimeout ?? 5000;
		this.idleTimeout = options.idleTimeout ?? 30000;
		this.healthCheckInterval = options.healthCheckInterval ?? 10000;

		this.startHealthCheck();
	}

	/**
	 * Acquires a connection from the pool
	 *
	 * @async
	 * @param {string} target
	 * @returns {Promise<Redis<RedisName>>}
	 */
	async acquire(target: string): Promise<Redis<RedisName>> {
		const poolKey = `pool:${target}`;
		let connection = this.connections.get(poolKey);

		if (!connection) {
			const currentCount = this.connectionCounts.get(target) ?? 0;

			if (currentCount >= this.maxConnectionsPerTarget) {
				return this.waitForConnection(target);
			}

			connection = await this.createConnection(target);
			this.connections.set(poolKey, connection);
			this.connectionCounts.set(target, currentCount + 1);
		}

		return connection;
	}

	/**
	 * Creates a new Redis connection
	 *
	 * @private
	 * @async
	 * @param {string} target
	 * @returns {Promise<Redis<RedisName>>}
	 */
	private async createConnection(target: string): Promise<Redis<RedisName>> {
		this.emitter.emit('connection:creating', { target });

		const connection = new Redis<RedisName>({
			...this.redisConfig,
			connectTimeout: this.connectionTimeout,
			lazyConnect: false
		} as any);

		await connection.connect();
		this.emitter.emit('connection:created', { target });
		return connection;
	}

	/**
	 * Waits for a connection to become available
	 *
	 * @private
	 * @async
	 * @param {string} target
	 * @returns {Promise<Redis<RedisName>>}
	 */
	private async waitForConnection(target: string): Promise<Redis<RedisName>> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(`Connection timeout for target: ${target}`));
			}, this.connectionTimeout);

			const checkConnection = () => {
				const connection = this.connections.get(`pool:${target}`);
				if (connection) {
					clearTimeout(timeout);
					resolve(connection);
				} else {
					setTimeout(checkConnection, 100);
				}
			};

			checkConnection();
		});
	}

	/**
	 * Releases a connection back to the pool
	 *
	 * @async
	 * @param {string} target
	 * @param {Redis<RedisName>} connection
	 * @returns {Promise<void>}
	 */
	async release(target: string, connection: Redis<RedisName>): Promise<void> {
		this.emitter.emit('connection:released', { target });
	}

	/**
	 * Starts health check interval
	 *
	 * @private
	 */
	private startHealthCheck(): void {
		this.healthChecker = setInterval(async () => {
			for (const [poolKey, connection] of this.connections.entries()) {
				try {
					await connection.ping();
				} catch (error) {
					this.emitter.emit('connection:unhealthy', { poolKey, error });

					this.connections.delete(poolKey);
					const target = poolKey.replace('pool:', '');
					const count = this.connectionCounts.get(target) ?? 0;
					this.connectionCounts.set(target, Math.max(0, count - 1));

					try {
						const newConnection = await this.createConnection(target);
						this.connections.set(poolKey, newConnection);
						this.connectionCounts.set(target, count);
					} catch (recreateError) {
						this.emitter.emit('connection:recreate-failed', { target, error: recreateError });
					}
				}
			}
		}, this.healthCheckInterval);
	}

	/**
	 * Destroys the connection pool
	 *
	 * @async
	 * @returns {Promise<void>}
	 */
	async destroy(): Promise<void> {
		if (this.healthChecker) {
			clearInterval(this.healthChecker);
		}

		for (const connection of this.connections.values()) {
			await connection.quit();
		}

		this.connections.clear();
		this.connectionCounts.clear();
	}

	/**
	 * Gets pool statistics
	 *
	 * @returns {{ totalConnections: number; connectionsByTarget: Record<string, number>; activeTargets: string[] }}
	 */
	getStats() {
		return {
			totalConnections: this.connections.size,
			connectionsByTarget: Object.fromEntries(this.connectionCounts),
			activeTargets: Array.from(this.connectionCounts.keys())
		};
	}

	/**
	 * Registers an event handler
	 *
	 * @param {string} event
	 * @param {(...args: any[]) => void} handler
	 */
	on(event: string, handler: (...args: any[]) => void) {
		this.emitter.on(event, handler);
	}
}
