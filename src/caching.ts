/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'crypto';
import { Redis } from 'redis-utils';
import type { Struct, Blank } from './back-end';

/**
 * Cache configuration
 *
 * @export
 * @typedef {CacheConfig}
 */
export type CacheConfig = {
	ttl?: number;
	invalidateOn?: ('create' | 'update' | 'delete' | 'archive' | 'restore')[];
	keyGenerator?: (params: any) => string;
};

/**
 * Cache entry with data and expiration
 *
 * @typedef {CacheEntry}
 */
interface CacheEntry {
	data: any;
	expires: number;
}

/**
 * Two-tier cache for struct queries
 *
 * @export
 * @class StructCache
 * @typedef {StructCache}
 * @template T
 * @template Name
 */
export class StructCache<T extends Blank, Name extends string> {
	private localCache = new Map<string, CacheEntry>();
	private pendingInvalidations = new Set<string>();
	private config: Required<CacheConfig>;

	/**
	 * Creates an instance of StructCache.
	 *
	 * @constructor
	 * @param {Struct<T, Name>} struct
	 * @param {Redis<any>} redis
	 * @param {CacheConfig} [config={}]
	 */
	constructor(
		private struct: Struct<T, Name>,
		private redis: Redis<any>,
		config: CacheConfig = {}
	) {
		this.config = {
			ttl: config.ttl ?? 300,
			invalidateOn: config.invalidateOn ?? ['create', 'update', 'delete', 'archive', 'restore'],
			keyGenerator: config.keyGenerator ?? this.defaultKeyGenerator.bind(this)
		};

		this.setupInvalidationListeners();
	}

	/**
	 * Default key generator using SHA256 hash
	 *
	 * @private
	 * @param {any} params
	 * @returns {string}
	 */
	private defaultKeyGenerator(params: any): string {
		const paramsStr = JSON.stringify(params, Object.keys(params).sort());
		const hash = createHash('sha256').update(paramsStr).digest('hex').substring(0, 16);
		return hash;
	}

	/**
	 * Generates cache key for a method and parameters
	 *
	 * @param {string} method
	 * @param {any} params
	 * @returns {string}
	 */
	generateCacheKey(method: string, params: any): string {
		const hash = this.config.keyGenerator(params);
		return `cache:${this.struct.name}:${method}:${hash}`;
	}

	/**
	 * Sets up automatic cache invalidation listeners
	 *
	 * @private
	 */
	private setupInvalidationListeners(): void {
		const invalidate = () => this.invalidateAll();

		if (this.config.invalidateOn.includes('create')) {
			this.struct.on('create', invalidate);
		}
		if (this.config.invalidateOn.includes('update')) {
			this.struct.on('update', invalidate);
		}
		if (this.config.invalidateOn.includes('delete')) {
			this.struct.on('delete', invalidate);
		}
		if (this.config.invalidateOn.includes('archive')) {
			this.struct.on('archive', invalidate);
		}
		if (this.config.invalidateOn.includes('restore')) {
			this.struct.on('restore', invalidate);
		}
	}

	/**
	 * Gets value from cache or executes fallback
	 *
	 * @async
	 * @template R
	 * @param {string} key
	 * @param {() => Promise<R>} fallback
	 * @param {boolean} [localOnly=false]
	 * @returns {Promise<R>}
	 */
	async get<R>(
		key: string,
		fallback: () => Promise<R>,
		localOnly = false
	): Promise<R> {
		const localEntry = this.localCache.get(key);
		if (localEntry && localEntry.expires > Date.now()) {
			return localEntry.data as R;
		}

		if (!localOnly) {
			const cached = await this.redis.get(key);
			if (cached) {
				const data = JSON.parse(cached, this.reviver);

				this.localCache.set(key, {
					data,
					expires: Date.now() + this.config.ttl * 1000
				});

				return data as R;
			}
		}

		const result = await fallback();
		await this.set(key, result);

		return result;
	}

	/**
	 * Sets value in cache
	 *
	 * @async
	 * @param {string} key
	 * @param {any} value
	 * @returns {Promise<void>}
	 */
	async set(key: string, value: any): Promise<void> {
		const serialized = JSON.stringify(value, this.replacer);

		await this.redis.setex(key, this.config.ttl, serialized);

		this.localCache.set(key, {
			data: value,
			expires: Date.now() + this.config.ttl * 1000
		});
	}

	/**
	 * Invalidates a specific cache key
	 *
	 * @async
	 * @param {string} key
	 * @returns {Promise<void>}
	 */
	async invalidate(key: string): Promise<void> {
		await this.redis.del(key);
		this.localCache.delete(key);

		await this.redis.publish(
			`invalidate:${this.struct.name}`,
			JSON.stringify({ key, timestamp: Date.now() })
		);
	}

	/**
	 * Invalidates all cache entries for this struct
	 *
	 * @async
	 * @returns {Promise<void>}
	 */
	async invalidateAll(): Promise<void> {
		const pattern = `cache:${this.struct.name}:*`;
		const keys = await this.redis.keys(pattern);

		if (keys.length > 0) {
			await this.redis.del(...keys);
		}

		for (const key of this.localCache.keys()) {
			if (key.startsWith(`cache:${this.struct.name}:`)) {
				this.localCache.delete(key);
			}
		}

		await this.redis.publish(
			`invalidate:${this.struct.name}`,
			JSON.stringify({ all: true, timestamp: Date.now() })
		);
	}

	/**
	 * Invalidates cache entries matching a pattern
	 *
	 * @async
	 * @param {string} pattern
	 * @returns {Promise<void>}
	 */
	async invalidateByPattern(pattern: string): Promise<void> {
		const keys = await this.redis.keys(pattern);
		if (keys.length > 0) {
			await this.redis.del(...keys);
		}

		for (const key of this.localCache.keys()) {
			if (key.match(new RegExp(pattern))) {
				this.localCache.delete(key);
			}
		}
	}

	/**
	 * JSON replacer for serialization
	 *
	 * @private
	 * @param {string} key
	 * @param {any} value
	 * @returns {*}
	 */
	private replacer(key: string, value: any) {
		if (value instanceof Date) {
			return { __type: 'Date', value: value.toISOString() };
		}
		return value;
	}

	/**
	 * JSON reviver for deserialization
	 *
	 * @private
	 * @param {string} key
	 * @param {any} value
	 * @returns {*}
	 */
	private reviver(key: string, value: any) {
		if (value && value.__type === 'Date') {
			return new Date(value.value);
		}
		return value;
	}

	/**
	 * Subscribes to cache invalidation messages
	 *
	 * @async
	 * @returns {Promise<void>}
	 */
	async subscribeToInvalidations(): Promise<void> {
		await this.redis.subscribe(`invalidate:${this.struct.name}`);

		this.redis.on('message', (channel, message) => {
			if (channel === `invalidate:${this.struct.name}`) {
				const payload = JSON.parse(message);

				if (payload.all) {
					this.localCache.clear();
				} else if (payload.key) {
					this.localCache.delete(payload.key);
				}
			}
		});
	}

	/**
	 * Gets cache statistics
	 *
	 * @returns {{ localCacheSize: number; pendingInvalidations: number }}
	 */
	getStats() {
		return {
			localCacheSize: this.localCache.size,
			pendingInvalidations: this.pendingInvalidations.size
		};
	}
}
