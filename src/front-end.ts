/* eslint-disable @typescript-eslint/no-explicit-any */
import { attempt, attemptAsync } from 'ts-utils/check';
import { EventEmitter, ComplexEventEmitter } from 'ts-utils/event-emitter';
import { match } from 'ts-utils/match';
import { Stream } from 'ts-utils/stream';
import { decode } from 'ts-utils/text';
import { DataAction, PropertyAction } from './types';
import { writable, type Readable, type Writable, get } from 'svelte/store';
import { type ColType } from './types';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { uniqueIndex } from 'drizzle-orm/mysql-core';
import { Loop } from 'ts-utils/loop';

/**
 * All actions that can be performed on the data
 *
 * @export
 * @enum {number}
 */
export enum FetchActions {
	/**
	 * Create a new data point
	 */
	Create = 'create',
	/**
	 * Delete a data point
	 */
	Delete = 'delete',
	/**
	 * Archive a data point
	 */
	Archive = 'archive',
	/**
	 * Restore an archived data point
	 */
	RestoreArchive = 'restore-archive',
	/**
	 * Restore a version of a data point
	 */
	RestoreVersion = 'restore-version',
	/**
	 * Delete a version of a data point
	 */
	DeleteVersion = 'delete-version',
	/**
	 * Retrieve a data's version history
	 */
	ReadVersionHistory = 'read-version-history',
	/**
	 * Get the archived data
	 */
	ReadArchive = 'read-archive',
	/**
	 * Read a data
	 */
	Read = 'read',
	/**
	 * Update a data point
	 */
	Update = 'update',
	/**
	 * Run a custom function on the back end
	 */
	Call = 'call',
	/**
	 * Custom query, this is used if a specific read type doesn't fulfill your needs.
	 */
	Query = 'query',
	// Retrieve = 'retrieve',
}

// TODO: Batching?

/**
 * Error if the data is an invalid state
 *
 * @export
 * @class DataError
 * @typedef {DataError}
 * @extends {Error}
 */
export class DataError extends Error {
	/**
	 * Creates an instance of DataError.
	 *
	 * @constructor
	 * @param {string} message
	 */
	constructor(message: string) {
		super(message);
		this.name = 'DataError';
	}
}

/**
 * Error if the struct is an invalid state
 *
 * @export
 * @class StructError
 * @typedef {StructError}
 * @extends {Error}
 */
export class StructError extends Error {
	/**
	 * Creates an instance of StructError.
	 *
	 * @constructor
	 * @param {string} message
	 */
	constructor(message: string) {
		super(message);
		this.name = 'StructError';
	}
}

/**
 * Error if the data is an invalid state, this should crash the application so use sparingly
 *
 * @export
 * @class FatalDataError
 * @typedef {FatalDataError}
 * @extends {Error}
 */
export class FatalDataError extends Error {
	/**
	 * Creates an instance of FatalDataError.
	 *
	 * @constructor
	 * @param {string} message
	 */
	constructor(message: string) {
		super(message);
		this.name = 'FatalDataError';
	}
}

/**
 * Error if the struct is an invalid state, this should crash the application so use sparingly
 *
 * @export
 * @class FatalStructError
 * @typedef {FatalStructError}
 * @extends {Error}
 */
export class FatalStructError extends Error {
	/**
	 * Creates an instance of FatalStructError.
	 *
	 * @constructor
	 * @param {string} message
	 */
	constructor(message: string) {
		super(message);
		this.name = 'FatalStructError';
	}
}

/**
 * Websocket/SSE connection to the server
 *
 * @export
 * @interface Socket
 * @typedef {Socket}
 */
export interface Socket {
	/**
	 * Event listener for the socket
	 *
	 * @param {string} event
	 * @param {(data: unknown) => void} lisener
	 */
	on(event: string, lisener: (data: unknown) => void): void;
}

/**
 * Generates a type from a column type
 *
 * @export
 * @typedef {ColTsType}
 * @template {ColType} t
 */
export type ColTsType<t extends ColType> = t extends 'string'
	? string
	: t extends 'number'
		? number
		: t extends 'boolean'
			? boolean
			: t extends 'array'
				? unknown[]
				: t extends 'json'
					? unknown
					: t extends 'date'
						? string
						: t extends 'bigint'
							? bigint
							: t extends 'custom'
								? unknown
								: t extends 'buffer'
									? Buffer
									: never;

/**
 * Blank struct type
 *
 * @export
 * @typedef {Blank}
 */
export type Blank = Record<string, ColType>;

/**
 * Configuration for a struct
 *
 * @export
 * @typedef {StructBuilder}
 * @template {Blank} T
 */
export type StructBuilder<T extends Blank> = {
	/**
	 * Name of the struct, this is used to identify the struct between the front and back ends
	 */
	name: string;
	/**
	 * Structure of the struct, this is used to validate the data and typing
	 */
	structure: T;
	/**
	 * Websocket/SSE connection to the server, must be present if the struct is to be used
	 */
	socket: Socket;
	/**
	 * Log all actions to the console (only use for development because this could log sensitive data and may slow down the application)
	 */
	log?: boolean;

	/**
	 * Whether the struct is a browser struct, this is used to prevent fetch requests on the server when sveltekit is doing SSR
	 */
	browser: boolean;


	cacheUpdates?: boolean;
};

/**
 * Not all users may have full read access to data, so all properties will be optional
 *
 * @export
 * @typedef {PartialStructable}
 * @template {Blank} T
 */
export type PartialStructable<T extends Blank> = {
	[K in keyof T]?: ColTsType<T[K]>;
};

/**
 * All users may have full read access to some data, so all properties will be required from this type
 *
 * @export
 * @typedef {Structable}
 * @template {Blank} T
 */
export type Structable<T extends Blank> = {
	[K in keyof T]: ColTsType<T[K]>;
};

/**
 * General status message for all actions. Use this format when generating your eventHandler() on the back end
 *
 * @export
 * @typedef {StatusMessage}
 * @template [T=void]
 */
export type StatusMessage<T = void> = {
	success: boolean;
	data?: T;
	message?: string;
};

/**
 * Version history of a data, requiring global columns and a version history id and created date
 *
 * @export
 * @typedef {VersionStructable}
 * @template {Blank} T
 */
export type VersionStructable<T extends Blank> = Structable<{
	vhId: 'string';
	vhCreated: 'date';
}> &
	PartialStructable<T & GlobalCols>;

/**
 * Version history point of a data.
 *
 * @export
 * @class StructDataVersion
 * @typedef {StructDataVersion}
 * @template {Blank} T
 */
export class StructDataVersion<T extends Blank> {
	/**
	 * Creates an instance of StructDataVersion.
	 *
	 * @constructor
	 * @param {Struct<T>} struct
	 * @param {PartialStructable<T & GlobalCols & {
	 *         vhId: 'string';
	 *         vhCreated: 'date';
	 *     }>} data
	 */
	constructor(
		public readonly struct: Struct<T>,
		public readonly data: PartialStructable<
			T &
				GlobalCols & {
					vhId: 'string';
					vhCreated: 'date';
				}
		>
	) {}

	/**
	 * unique version history id
	 *
	 * @readonly
	 * @type {string}
	 */
	get vhId() {
		return this.data.vhId;
	}

	/**
	 * Id of the data this relates to
	 *
	 * @readonly
	 * @type {string}
	 */
	get id() {
		return this.data.id;
	}

	/**
	 * Date the version was created
	 *
	 * @readonly
	 * @type {Date}
	 */
	get vhCreated() {
		return this.data.vhCreated;
	}

	/**
	 * Date the data was created
	 *
	 * @readonly
	 * @type {string}
	 */
	get created() {
		return this.data.created;
	}

	/**
	 * Date the data was last updated
	 *
	 * @readonly
	 * @type {string}
	 */
	get updated() {
		return this.data.updated;
	}

	/**
	 * Whether the data is archived
	 *
	 * @readonly
	 * @type {boolean}
	 */
	get archived() {
		return this.data.archived;
	}

	/**
	 *  Lifespan of the data in milliseconds
	 *
	 * @readonly
	 * @type {number}
	 */
	get lifetime() {
		return this.data.lifetime;
	}

	/**
	 * Delete the version
	 *
	 * @returns {*}
	 */
	delete() {
		return attemptAsync<StatusMessage>(async () => {
			return this.struct
				.post(DataAction.DeleteVersion, {
					id: this.data.id,
					vhId: this.data.vhId
				})
				.then((r) => r.unwrap().json());
		});
	}

	/**
	 * Restore the version
	 *
	 * @returns {*}
	 */
	restore() {
		return attemptAsync<StatusMessage>(async () => {
			return this.struct
				.post(DataAction.RestoreVersion, {
					id: this.data.id,
					vhId: this.data.vhId
				})
				.then((r) => r.unwrap().json());
		});
	}
}

/**
 * The current version for struct updates stored in localStorage
 *
 * @type {1}
 */
const STRUCT_UPDATE_VERSION = 1;

/**
 * Batch update schema for struct updates
 *
 * @type {*}
 */
const structUpdateSchema = z.object({
	struct: z.string(),
	type: z.string(),
	data: z.unknown(),
	id: z.string(),
	date: z.string()
});

/**
 * Retrieves all cached struct updates from localStorage
 *
 * @returns {*} 
 */
export const getStructUpdates = () => {
	return attempt(() => {
		const data = window.localStorage.getItem(`struct-updates-v${STRUCT_UPDATE_VERSION}`);
		if (!data) return [];

		const parsed = z.array(structUpdateSchema).parse(JSON.parse(data));

		const now = Date.now();
		const DAY_MS = 1000 * 60 * 60 * 24;

		const valid = parsed.filter(u => {
			const time = new Date(u.date).getTime();
			return now - time <= DAY_MS;
		});

		// Clean expired from localStorage
		if (valid.length !== parsed.length) {
			window.localStorage.setItem(`struct-updates-v${STRUCT_UPDATE_VERSION}`, JSON.stringify(valid));
		}

		return valid;
	});
};

/**
 * Saves a struct update to localStorage, this will not send the update to the server
 *
 * @param {{
 * 	struct: string;
 * 	type: string;
 * 	data: unknown;
 * 	id: string;
 * }} data 
 * @returns {*} 
 */
export const saveStructUpdate = (data: {
	struct: string;
	type: string;
	data: unknown;
	id: string;
}) => {
	return attempt(() => {
		const now = Date.now();
		const DAY_MS = 1000 * 60 * 60 * 24;

		// Get and prune expired updates first
		const arr = getStructUpdates()
			.unwrap()
			.filter(u => now - new Date(u.date).getTime() <= DAY_MS);

		// Add new update
		arr.push({
			...data,
			date: new Date(Struct.getDate()).toISOString(),
		});

		window.localStorage.setItem(`struct-updates-v${STRUCT_UPDATE_VERSION}`, JSON.stringify(arr));
		return arr;
	});
};


/**
 * Deletes a struct update from localStorage, this will not send the update to the server
 *
 * @param {string} id 
 * @returns {*} 
 */
export const deleteStructUpdate = (id: string) => {
	return attempt(() => {
		const arr = getStructUpdates()
			.unwrap()
			.filter(u => u.id !== id);
		window.localStorage.setItem(`struct-updates-v${STRUCT_UPDATE_VERSION}`, JSON.stringify(arr));

		return arr;
	});
}

/**
 * Sends all updates that are due to the server in a batch operation, this will not save them to localStorage
 *
 * @param {boolean} browser 
 * @param {number} threshold 
 * @returns {*} 
 */
export const sendUpdates = (browser: boolean, threshold: number) => {
	return attemptAsync(async () => {
		if (!browser) return;

		const all = getStructUpdates().unwrap();
		if (!all.length) return [];

		const due = all.filter(u => (Struct.getDate() - new Date(u.date).getTime()) >= threshold);
		if (!due.length) return [];

		let res: unknown;
		try {
			res = await fetch('/struct/batch', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(due),
			}).then(r => r.json());
		} catch (err) {
			// Network failure – keep everything
			console.warn('struct update send failed, keeping all local data', err);
			return [];
		}

		// Parse server response (optional: validate here)
		const parsed = z.array(z.object({
			id: z.string(),
			success: z.boolean(),
			message: z.string().optional(),
			data: z.unknown().optional(),
		})).safeParse(res);

		if (!parsed.success) {
			console.warn('Invalid server response for struct updates:', res);
			return [];
		}

		// Remove all items that were sent, regardless of server result
		const remaining = all.filter(a => !due.find(d => d.id === a.id));
		window.localStorage.setItem(`struct-updates-v${STRUCT_UPDATE_VERSION}`, JSON.stringify(remaining));

		return parsed.data;
	});
};

/**
 * Starts a loop that sends updates to the server at a specified interval
 *
 * @param {boolean} browser 
 * @param {number} interval 
 * @param {number} threshold 
 * @returns {*} 
 */
export const startBatchUpdateLoop = (browser: boolean, interval: number, threshold: number) => {
	const l = new Loop<{
		error: Error;
	}>(async () => {
		const res = await sendUpdates(browser, threshold);
		if (res.isErr()) {
			console.error(res.error);
			l.emit('error', res.error);
		}
	}, interval);
	l.start();
	return l;
};

/**
 * Clears all struct updates from localStorage, this will not send the updates to the server
 *
 * @returns {*} 
 */
export const clearStructUpdates = () => {
	return attempt(() => {
		window.localStorage.removeItem(`struct-updates-v${STRUCT_UPDATE_VERSION}`);
		return [];
	});
};

/**
 * Batch update type - used for custom batches
 *
 * @typedef {BatchUpdate}
 * @template {DataAction | PropertyAction} T 
 */
type BatchUpdate<T extends DataAction | PropertyAction> = {
	struct: string;
	type: DataAction | PropertyAction;
	data: unknown;
	id: string;
	date: string;
}

/**
 * This isn't currently implemented, but this is a placeholder for a batch send function, rather than just storing it all in cache
 * @deprecated
 * @param {{
 * 	struct: string;
 * 	type: DataAction | PropertyAction;
 * 	data: unknown;
 * 	id: string;
 * 	date: string;
 * }[]} data 
 */
export const sendBatch = (data: {
	struct: string;
	type: DataAction | PropertyAction;
	data: unknown;
	id: string;
	date: string;
}[]) => {}

/**
 * Sets up a batch test mode. This should only be set to true in a testing environment. Otherwise no data will be sent
 *
 * @type {boolean}
 */
let BATCH_TEST = false;

/**
 * Initializes the batch test mode, this will not send any data to the server. This is used for testing purposes only.
 *
 * @returns {true} 
 */
export const startBatchTest = (): true => {
	return BATCH_TEST = true;
};

/**
 * Ends the batch test mode, this will not send any data to the server. This is used for testing purposes only.
 *
 * @returns {false} 
 */
export const endBatchTest = (): false => {
	return BATCH_TEST = false;
};


/**
 * Struct data for a single data point
 *
 * @export
 * @class StructData
 * @typedef {StructData}
 * @template {Blank} T
 * @implements {Writable<PartialStructable<T & GlobalCols>>}
 */
export class StructData<T extends Blank> implements Writable<PartialStructable<T & GlobalCols>> {
	/**
	 * Creates an instance of StructData.
	 *
	 * @constructor
	 * @param {Struct<T>} struct
	 * @param {(PartialStructable<T & GlobalCols>)} data
	 */
	constructor(
		public readonly struct: Struct<T>,
		public data: PartialStructable<T> & PartialStructable<GlobalCols>
	) {}

	/**
	 * Svelte store subscribers, used to automatically update the view
	 *
	 * @private
	 * @type {*}
	 */
	private subscribers = new Set<(value: PartialStructable<T & GlobalCols>) => void>();

	/**
	 * Subscribe to the data
	 *
	 * @public
	 * @param {(value:  PartialStructable<T & GlobalCols>) => void} fn
	 * @returns {() => void}
	 */
	public subscribe(fn: (value: PartialStructable<T & GlobalCols>) => void): () => void {
		this.subscribers.add(fn);
		fn(this.data);
		return () => {
			this.subscribers.delete(fn);
		};
	}

	// this is what will set in the store
	/**
	 * Sets the data and updates the subscribers, this will not update the backend
	 *
	 * @public
	 * @param {(PartialStructable<T & GlobalCols>)} value
	 */
	public set(value: PartialStructable<T & GlobalCols>): void {
		this.data = value;
		this.subscribers.forEach((fn) => fn(value));
	}

	// this is what will send to the backend
	/**
	 * Update the data in the backend, this will not update the subscribers as the backend will send the update back
	 *
	 * @public
	 * @async
	 * @param {(value: PartialStructable<T & GlobalCols>) => PartialStructable<T & {
	 *         id: 'string';
	 *     }>} fn
	 * @returns {(PartialStructable<T & { id: "string"; }>) => unknown)}
	 */
	public async update(
		fn: (value: PartialStructable<T & GlobalCols>) => PartialStructable<
			T & {
				id: 'string';
			}
		>
	) {
		return attemptAsync(async () => {
			if (!this.data.id) throw new StructError('Unable to update data, no id found');
			const prev = { ...this.data };

			const result = fn(this.data);
			delete result.archived;
			delete result.created;
			delete result.updated;
			delete result.lifetime;
			delete result.universes;
			delete result.attributes;
			delete result.canUpdate;

			const res = (await this.struct.post(PropertyAction.Update, {
				data: result,
				id: this.data.id,
			})).unwrap();
			return {
				result: (await res.json()) as StatusMessage,
				undo: () => this.update(() => prev)
			};
		});
	}

	/**
	 * Delete the data
	 *
	 * @returns {*}
	 */
	delete() {
		return attemptAsync<StatusMessage>(async () => {
			return this.struct
				.post(DataAction.Delete, {
					id: this.data.id
				})
				.then((r) => r.unwrap().json());
		});
	}

	/**
	 * Archive or restore the data
	 *
	 * @param {boolean} archive
	 * @returns {*}
	 */
	setArchive(archive: boolean) {
		return attemptAsync<StatusMessage>(async () => {
			if (archive) {
				return this.struct
					.post(DataAction.Archive, {
						id: this.data.id
					})
					.then((r) => r.unwrap().json());
			}
			return this.struct
				.post(DataAction.RestoreArchive, {
					id: this.data.id
				})
				.then((r) => r.unwrap().json());
		});
	}

	/**
	 * Pull specific properties from the data, if the user does not have permission to read the property it will throw an error.
	 * This is not wrapped in an attempt(() => {}), so you will need to handle errors yourself. This will return a svelte store.
	 *
	 * @template {keyof T} Key
	 * @param {...Key[]} keys
	 * @returns {*}
	 */
	pull<Key extends keyof T>(...keys: Key[]) {
		const o = {} as Structable<{
			[Property in Key]: T[Property];
		}>;

		for (const k of keys) {
			if (typeof this.data[k] === 'undefined') {
				return console.error(
					`User does not have permissions to read ${this.struct.data.name}.${k as string}`
				);
			}
			(o as any)[k] = this.data[k];
		}

		class PartialReadable implements Readable<typeof o> {
			constructor(public data: typeof o) {}

			public readonly subscribers = new Set<(data: typeof o) => void>();

			subscribe(fn: (data: typeof o) => void) {
				this.subscribers.add(fn);
				fn(o);
				return () => {
					this.subscribers.delete(fn);
					if (this.subscribers.size === 0) {
						return u();
					}
				};
			}
		}

		const w = new PartialReadable(o);

		const u = this.subscribe((d) => {
			Object.assign(o, d);
		});

		return w;
	}

	/**
	 * Retrieves all attributes the data has
	 *
	 * @returns {*}
	 */
	getAttributes() {
		return attempt(() => {
			const a = JSON.parse(this.data.attributes || '[]');
			if (!Array.isArray(a)) throw new DataError('Attributes must be an array');
			if (!a.every((i) => typeof i === 'string'))
				throw new DataError('Attributes must be an array of strings');
			return a;
		});
	}

	/**
	 * Sets the attributes of the data, this will overwrite any existing attributes.
	 *
	 * @param {string[]} attributes 
	 * @returns {*} 
	 */
	setAttributes(attributes: string[]) {
		return attemptAsync(async () => {
			if (!this.data.id) throw new StructError('Unable to set attributes, no id found');
			if (!Array.isArray(attributes)) {
				throw new DataError('Attributes must be an array of strings');
			}
			if (!attributes.every((a) => typeof a === 'string')) {
				throw new DataError('Attributes must be an array of strings');
			}

			const res = await this.struct.post(PropertyAction.SetAttributes, {
				id: this.data.id,
				attributes
			}).unwrap();

			const result = await res.json() as StatusMessage<string[]>;
			if (!result.success) {
				throw new DataError(result.message || 'Failed to set attributes');
			}

			this.data.attributes = JSON.stringify(result.data);
			return this.getAttributes().unwrap();
		});
	}

	/**
	 * Adds new attributes to the data, this will not overwrite existing attributes.
	 *
	 * @param {...string[]} attributes 
	 * @returns {*} 
	 */
	addAttributes(...attributes: string[]) {
		return attemptAsync(async () => {
			const current = this.getAttributes().unwrap();
			return this.setAttributes(
				Array.from(new Set([...current, ...attributes]))
			).unwrap();
		});
	}

	/**
	 * Removes attributes from the data, this will not throw an error if the attribute does not exist.
	 *
	 * @param {...string[]} attributes 
	 * @returns {*} 
	 */
	removeAttributes(...attributes: string[]) {
		return attemptAsync(async () => {
			const current = this.getAttributes().unwrap();
			const newAttributes = current.filter((a) => !attributes.includes(a));
			return this.setAttributes(newAttributes).unwrap();
		});
	}

	/**
	 * Retrieves all versions of the data
	 *
	 * @returns {*}
	 */
	getVersions() {
		return attemptAsync(async () => {
			const versions = (await this.struct
				.post(PropertyAction.ReadVersionHistory, {
					id: this.data.id
				})
				.then((r) => r.unwrap().json())) as StatusMessage<VersionStructable<T>[]>;

			if (!versions.success) {
				throw new DataError(versions.message || 'Failed to get versions');
			}

			return versions.data?.map((v) => new StructDataVersion(this.struct, v)) || [];
		});
	}
}

/**
 * Used in data proxies - a conflict is when both the local and remote data differ from the base data and from each other.
 *
 * @typedef {Conflict}
 * @template {Blank} T 
 * @template {keyof T} K 
 */
type Conflict<T extends Blank, K extends keyof T> = {
	property: K;
	baseValue: PartialStructable<T>[K];
	localValue: PartialStructable<T>[K];
	remoteValue: PartialStructable<T>[K];
}

/**
 * Conflict resolution function
 *
 * @typedef {FullConflictResolver}
 * @template {Blank} T 
 */
type FullConflictResolver<T extends Blank> = (args: {
	base: PartialStructable<T & GlobalCols>;
	local: PartialStructable<T & GlobalCols>;
	remote: PartialStructable<T & GlobalCols>;
	conflicts: {
	}[];
}) => PartialStructable<T> | Promise<PartialStructable<T>>;

/**
 * Save strategy for struct data, this is used to determine how to handle conflicts when saving data.
 *
 * @typedef {SaveStrategy}
 * @template {Blank} T 
 */
type SaveStrategy<T extends Blank> =
	| 'ifClean'
	| 'force'
	| 'preferLocal'
	| 'preferRemote'
	| 'mergeClean'
	| 'manual'
	| FullConflictResolver<T>;

/**
 * Status of a merge operation, this is used to determine the state of the local and remote data in relation to the base data.
 *
 * @typedef {MergeStatus}
 */
type MergeStatus =
  | 'clean'          // local == remote == base, no changes
  | 'localDiverge'   // local differs from base, remote == base
  | 'remoteDiverge'  // remote differs from base, local == base
  | 'diverged'       // local and remote both differ from base, but local == remote (no conflict)
  | 'conflicted';    // local and remote both differ from base and differ from each other (conflict)

/**
 * State of a merge operation, this is used to track the status and conflicts during a merge.
 *
 * @interface MergeState
 * @typedef {MergeState}
 * @template {Blank} T 
 * @template {keyof T} K 
 */
interface MergeState<T extends Blank, K extends keyof T> {
  /**
   * Status of the merge operation, indicating the relationship between local, remote, and base data.
   *
   * @type {MergeStatus}
   */
  status: MergeStatus;
  /**
   * Any local changes that have been made to the data that have not yet been saved and conflict with remote data.
   *
   * @type {Conflict<T, keyof T>[]}
   */
  conflicts: Conflict<T, keyof T>[];
}

/**
 * Global columns that are always present in every struct data.
 */
type StructDataProxyConfig<T extends Blank> = {
	/**
	 * Prevents the proxy from modifying these properties.
	 */
	static?: (keyof T)[];
}

/**
 * A proxy wrapper for StructData that allows local changes to be staged
 * before being saved to the backend. It tracks both local and remote changes.
 *
 * Local changes are made through `data`, and changes will not be pushed
 * to the backend until `.save()` is called.
 *
 * Remote updates from the backend trigger a flag (`remoteUpdated`) but do
 * not modify the local data until `.pull()` is called.
 *
 * @template T The shape of the base struct (excluding global columns).
 */
export class StructDataProxy<T extends Blank> implements Writable<PartialStructable<T & GlobalCols>> {
	/**
	 * The proxied, locally-editable version of the data.
	 * Modifying this triggers change tracking but does not affect the backend until `.save()`.
	 */
	public data: PartialStructable<T & GlobalCols>;

	
	/**
	 * The base data structure, which is a snapshot of the remote data
	 *
	 * @public
	 * @type {PartialStructable<T & GlobalCols>}
	 */
	public base: PartialStructable<T & GlobalCols>;

	/** Tracks whether the backend (remote) data has changed since the last pull. */
	public readonly remoteUpdated = writable(false);

	/** Tracks whether the local data has been modified since the last save or pull. */
	public readonly localUpdated = writable(false);

	/**
	 * Unsubscribe from the StructData's data updates.
	 *
	 * @private
	 * @type {() => void}
	 */
	private dataUnsub: () => void;
	/**
	 * Set of subscribers that will be notified when the local data changes. 
	 *
	 * @private
	 * @readonly
	 * @type {*}
	 */
	private readonly subscribers = new Set<(data: PartialStructable<T & GlobalCols>) => void>();
	/** Runs once all subscribers are done */
	private _onAllUnsubscribe = () => {};

	/**
	 * @param structData The live backend-backed StructData instance to proxy.
	 */
	constructor(
		public readonly structData: StructData<T & GlobalCols>,
		public readonly config: StructDataProxyConfig<T> = {}
	) {
		this.data = this.makeProxy(structData.data);
		this.dataUnsub = this.structData.subscribe(() => {
			this.remoteUpdated.set(true);
		});
		this.base = JSON.parse(JSON.stringify(this.data)) as PartialStructable<T & GlobalCols>;
	}

	/**
	 * Creates a reactive proxy for the provided data object.
	 * Any mutation will trigger subscribers and mark the local state as dirty.
	 */
	private makeProxy(data: PartialStructable<T & GlobalCols>) {
		return new Proxy(
			JSON.parse(JSON.stringify(data)) as PartialStructable<T & GlobalCols>,
			{
				set: (target, property, value) => {
					if (this.config.static?.includes(property as keyof T)) {
						throw new Error(`Cannot modify static property "${String(property)}" in StructDataProxy`);
					}
					if (target[property as keyof typeof target] !== value) {
						target[property as keyof typeof target] = value;
						this.inform();
					}
					this.setLocalChanged();
					return true;
				},
				deleteProperty: (target, property) => {
					throw new Error(`Cannot delete property "${String(property)}" from StructDataProxy`);
				}
			}
		);
	}

	/**
	 * Sets the local change flag based on whether the current data
	 *
	 * @private
	 */
	private setLocalChanged() {
		if (Object.keys(this.data).every(k => this.data[k] === this.base[k])) {
			this.localUpdated.set(false);
		} else {
			this.localUpdated.set(true);
		}
	}

	/**
	 * Subscribes to changes in the local data proxy.
	 * This is separate from backend changes — only local modifications trigger these.
	 *
	 * @param fn The function to call when local data is modified.
	 * @returns A cleanup function to unsubscribe.
	 */
	public subscribe(fn: (data: PartialStructable<T & GlobalCols>) => void) {
		fn(this.data);
		this.subscribers.add(fn);
		return () => {
			this.subscribers.delete(fn);
			if (this.subscribers.size === 0) {
				this._onAllUnsubscribe();
				this.dataUnsub();
			}
		};
	}

	/**
	 * Sets a callback that runs when all subscribers have unsubscribed.
	 *
	 * @param fn A cleanup function.
	 */
	public onAllUnsubscribe(fn: () => void) {
		this._onAllUnsubscribe = fn;
	}

	/** Notifies all subscribers of the current local data state. */
	public inform() {
		this.subscribers.forEach(fn => fn(this.data));
	}

	/**
	 * Replaces the current local data with a new object.
	 * Triggers change tracking and subscribers.
	 *
	 * @param data The new data to replace with.
	 * @returns The newly proxied data object.
	 */
	public set(data: PartialStructable<T & GlobalCols>) {
		this.data = this.makeProxy(data);
		this.inform();
		this.localUpdated.set(true);
		return this.data;
	}

	/**
	 * Applies a transformation function to the local data.
	 * Triggers change tracking and subscribers.
	 *
	 * @param fn A function that receives and returns the new data shape.
	 * @returns The newly proxied data object.
	 */
	public update(fn: (data: PartialStructable<T & GlobalCols>) => PartialStructable<T & GlobalCols>) {
		this.data = this.makeProxy(fn(this.data));
		this.inform();
		this.localUpdated.set(true);
		return this.data;
	}
	/**
	 * Resets the local state to match the backend data,
	 * clearing both local and remote change flags.
	 */
	public pull() {
		this.remoteUpdated.set(false);
		this.localUpdated.set(false);
		this.data = this.makeProxy(this.structData.data);
		this.base = JSON.parse(JSON.stringify(this.data)) as PartialStructable<T & GlobalCols>;
		this.inform();
	}

	/**
	 * Reverts local changes, resetting data to the base snapshot.
	 * This is a **local-only** operation; it does not affect the backend or pull the current remote state.
	 * 
	 * - If specific properties are provided, only those will be reset.
	 * - If no properties are given, the entire object is reset to the base snapshot.
	 * 
	 * @param properties - List of property keys to selectively rollback. If empty, resets all properties.
	 * @throws {Error} If a static property is attempted to be modified.
	 * @throws {Error} If a given property does not exist in the base snapshot.
	 */
	public rollback(...properties: (keyof T)[]) {
		return attempt(() => {
				if (properties.length > 0) {
				let hasChanges = false;

				for (const p of properties) {
					if (this.config.static?.includes(p)) {
						throw new Error(`Cannot modify static property "${String(p)}" in StructDataProxy`);
					}
					if (p in this.base) {
						const baseValue = this.base[p];
						if (this.data[p] !== baseValue) {
							(this.data as any)[p] = baseValue;
							hasChanges = true;
						}
					} else {
						throw new Error(`Property "${String(p)}" does not exist in base data`);
					}
				}

				if (hasChanges) {
					this.inform();
				}
				this.setLocalChanged();

				return;
			}

			// Full rollback
			this.data = this.makeProxy(this.base);
			this.inform();
			this.localUpdated.set(false);
		});
	}


	/**
	 * Returns whether the local or remote data has diverged
	 * from the current proxied state.
	 *
	 * @returns `true` if either `localUpdated` or `remoteUpdated` is `true`.
	 */
	public isDirty(): boolean {
		return get(this.localUpdated) || get(this.remoteUpdated);
	}

	/**
	 * Returns whether the backend (remote) has changed since the last `pull()`.
	 */
	public remoteChanged(): boolean {
		return get(this.remoteUpdated);
	}

	/**
	 * Returns whether the local data has been changed since the last `save()` or `pull()`.
	 */
	public localChanged(): boolean {
		return get(this.localUpdated);
	}


	/**
	 * Attempts to save local changes to the underlying struct data, resolving any conflicts
	 * using the specified strategy.
	 *
	 * A conflict is defined as a property where:
	 *   - both the local and remote values differ from the base, and
	 *   - the local and remote values are not equal.
	 *
	 * @param strategy - Determines how to handle differences and conflicts:
	 *
	 *  - `"ifClean"`:
	 *      - Only saves if remote is identical to base.
	 *      - Throws if any remote change is detected.
	 *
	 *  - `"force"`:
	 *      - Ignores conflicts and always overwrites remote with local values.
	 *
	 *  - `"preferLocal"`:
	 *      - In conflicts, prefers local value.
	 *      - In non-conflicts, prefers whichever value (local or remote) has changed from base.
	 *
	 *  - `"preferRemote"`:
	 *      - In conflicts, prefers remote value.
	 *      - In non-conflicts, prefers whichever value (local or remote) has changed from base.
	 *
	 *  - `"mergeClean"`:
	 *      - Throws if any conflicts exist.
	 *      - Otherwise, merges values that differ from base (either local or remote).
	 *
	 *
	 *  - `function(conflict): value`:
	 *      - A custom resolver function called for each conflict.
	 *      - Should return the resolved value for each property.
	 *
	 * After a successful save, the base snapshot is updated and all dirty flags are cleared.
	 */
	public async save(strategy: SaveStrategy<T>) {
		return attemptAsync(async () => {
			const local = this.data;
			const remote = this.structData.data;
			const base = this.base;

			const keys = new Set([
				...Object.keys(local),
				...Object.keys(remote),
				...Object.keys(base)
			]) as Set<keyof T>;

			const conflicts: {
				property: keyof T;
				baseValue: PartialStructable<T>[keyof T];
				localValue: PartialStructable<T>[keyof T];
				remoteValue: PartialStructable<T>[keyof T];
			}[] = [];

			const merged: PartialStructable<T> = {};

			for (const key of keys) {
				const baseValue = base[key];
				const localValue = local[key];
				const remoteValue = remote[key];

				const localChanged = localValue !== baseValue;
				const remoteChanged = remoteValue !== baseValue;
				const isConflict = localChanged && remoteChanged && localValue !== remoteValue;

				if (isConflict) {
					conflicts.push({ 
						property: key, 
						baseValue: baseValue as PartialStructable<T>[keyof T], 
						localValue: localValue as PartialStructable<T>[keyof T], 
						remoteValue: remoteValue as PartialStructable<T>[keyof T],
					});
				}

				if (typeof strategy === 'string') {
					switch (strategy) {
						case 'ifClean':
							if (remoteChanged) throw new Error('Remote has diverged from base');
							if (localChanged) merged[key] = localValue;
							break;

						case 'force':
							merged[key] = localValue;
							break;

						case 'preferLocal':
							(merged as any)[key] = isConflict || localChanged ? localValue : remoteValue;
							break;

						case 'preferRemote':
							(merged as any)[key] = isConflict || remoteChanged ? remoteValue : localValue;
							break;

						case 'mergeClean':
							if (isConflict) throw new Error('Conflicts prevent mergeClean');
							if (localChanged) merged[key] = localValue;
							else if (remoteChanged) (merged as any)[key] = remoteValue;
							break;

						case 'manual':
							if (conflicts.length > 0) {
								throw {
									message: 'Manual merge required',
									base,
									local,
									remote,
									conflicts
								};
							}
							if (localChanged) merged[key] = localValue;
							break;

						default:
							throw new Error(`Unknown strategy: ${strategy satisfies never}`);
					}
				}
			}

			if (typeof strategy === 'function') {
				const resolved = await strategy({
					base,
					local,
					remote,
					conflicts
				});

				Object.assign(merged, resolved);
			}

			if (Object.keys(merged).length > 0) {
				await this.structData.update(d => ({ ...d, ...merged }));
				this.localUpdated.set(false);
				this.remoteUpdated.set(false);
				this.base = structuredClone(this.data);
				this.inform();
			}
		});
	}


	/**
	 * 
	 * @returns {MergeState<T>} The current merge state, including status and any conflicts.
	 */
	public getMergeState(): MergeState<T, keyof T> {
		const local = this.data;
		const remote = this.structData.data;
		const base = this.base;

		const conflicts: MergeState<T, keyof T>['conflicts'] = [];
		let hasLocalDiverge = false;
		let hasRemoteDiverge = false;
		let hasConflict = false;

		const keys = new Set([
			...Object.keys(local),
			...Object.keys(remote),
			...Object.keys(base),
		]) as Set<keyof T>;

		for (const key of keys) {
			const localValue = local[key];
			const remoteValue = remote[key];
			const baseValue = base[key];

			if (localValue === undefined || remoteValue === undefined || baseValue === undefined)
			continue;

			const localChanged = localValue !== baseValue;
			const remoteChanged = remoteValue !== baseValue;

			if (localChanged) hasLocalDiverge = true;
			if (remoteChanged) hasRemoteDiverge = true;

			if (localChanged && remoteChanged && localValue !== remoteValue) {
				hasConflict = true;
				conflicts.push({ 
					property: key, 
					localValue: localValue as PartialStructable<T>[keyof T], 
					remoteValue: remoteValue as PartialStructable<T>[keyof T], 
					baseValue: baseValue as PartialStructable<T>[keyof T],
				});
			}
		}

		let status: MergeStatus;

		if (!hasLocalDiverge && !hasRemoteDiverge) status = 'clean';
		else if (hasConflict) status = 'conflicted';
		else if (hasLocalDiverge && hasRemoteDiverge) status = 'diverged';
		else if (hasLocalDiverge) status = 'localDiverge';
		else /* hasRemoteDiverge */ status = 'remoteDiverge';

		return { status, conflicts };
	}
}


/**
 * Svelte store data array, used to store multiple data points and automatically update the view
 *
 * @export
 * @class DataArr
 * @typedef {DataArr}
 * @template {Blank} T
 * @implements {Readable<StructData<T>[]>}
 */
export class DataArr<T extends Blank> implements Writable<StructData<T>[]> {
	/**
	 * A set of StructData objects that this DataArr holds.
	 *
	 * @private
	 * @readonly
	 * @type {Set<StructData<T>>}
	 */
	private readonly dataset: Set<StructData<T>>;

	/**
	 * Creates an instance of DataArr.
	 *
	 * @constructor
	 * @param {Struct<T>} struct
	 * @param {StructData<T>[]} data
	 */
	constructor(
		public readonly struct: Struct<T>,
		data: StructData<T>[]
	) {
		this.dataset = new Set(data);
	}

	/**
	 * All subscribers to the data array
	 *
	 * @private
	 * @type {*}
	 */
	private readonly subscribers = new Set<(value: StructData<T>[]) => void>();

	/**
	 * Retrieves all data points in the array.
	 *
	 * @public
	 * @type {{}}
	 */
	public get data() {
		return Array.from(this.dataset);
	}

	/**
	 * Sets the data array to a new value, clearing the existing dataset and adding the new values.
	 *
	 * @public
	 * @type {{}}
	 */
	public set data(value: StructData<T>[]) {
		this.dataset.clear();
		for (let i = 0; i < value.length; i++) {
			this.dataset.add(value[i]);
		}
		this.inform();
	}

	/**
	 * Subscribe to the data array
	 *
	 * @public
	 * @param {(value: StructData<T>[]) => void} fn
	 * @returns {() => void}
	 */
	public subscribe(fn: (value: StructData<T>[]) => void): () => void {
		this.subscribers.add(fn);
		fn(this.data);
		return () => {
			this.subscribers.delete(fn);
			if (this.subscribers.size === 0) {
				this._onAllUnsubscribe?.();
			}
		};
	}

	/**
	 * Applies the new state to the data array and updates the subscribers
	 *
	 * @private
	 * @param {StructData<T>[]} value
	 */
	private apply(value: StructData<T>[]): void {
		this.data = value
			.sort(this._sort)
			.filter(this._filter);
		this.subscribers.forEach((fn) => fn(this.data));
		this.struct.log('Applied Data:', this.data);
	}

	/**
	 * Adds data to the array and updates the subscribers
	 *
	 * @public
	 * @param {...StructData<T>[]} values
	 */
	public add(...values: StructData<T>[]): void {
		this.apply([...this.data, ...values]);
	}

	/**
	 *Removes data from the array and updates the subscribers
	 *
	 * @public
	 * @param {...StructData<T>[]} values
	 */
	public remove(...values: StructData<T>[]): void {
		this.apply(this.data.filter((value) => !values.includes(value)));
	}

	/**
	 * Runs when all subscribers have been removed
	 *
	 * @private
	 * @type {(() => void) | undefined}
	 */
	private _onAllUnsubscribe: (() => void) | undefined;
	/**
	 * Add listener for when all subscribers have been removed
	 *
	 * @public
	 * @param {() => void} fn
	 */
	public onAllUnsubscribe(fn: () => void): void {
		this._onAllUnsubscribe = fn;
	}

	/**
	 * Sorts the data array using a custom sorting function.
	 *
	 * @param {StructData<T>} a 
	 * @param {StructData<T>} b 
	 * @returns {number} 
	 */
	private _sort: (a: StructData<T>, b: StructData<T>) => number = (a, b) => 0;

	/**
	 * Sets a custom sorting function for the data array.
	 *
	 * @param {(a: StructData<T>, b: StructData<T>) => number} fn 
	 * @returns {number) => void} 
	 */
	sort(fn: (a: StructData<T>, b: StructData<T>) => number) {
		this._sort = fn;
		this.inform();
	}

	/**
	 * Filters the data array using a custom filtering function.
	 *
	 * @returns {true} 
	 */
	private _filter: (data: StructData<T>) => boolean = () => true;

	/**
	 * Sets a custom filtering function for the data array.
	 *
	 * @param {(data: StructData<T>) => boolean} fn 
	 * @returns {boolean) => void} 
	 */
	filter(fn: (data: StructData<T>) => boolean) {
		this._filter = fn;
		this.inform();
	}

	/** 
	 * Informs the array to emit updates without any local changes
	 */
	inform() {
		this.apply(this.data);
	}

	/**
	 * Sets the data array to a new value and updates the subscribers.
	 *
	 * @public
	 * @param {StructData<T>[]} value 
	 */
	public set(value: StructData<T>[]) {
		this.apply(value);
	}

	/**
	 * Updates the data array using a function that receives the current data.
	 *
	 * @public
	 * @param {(data: StructData<T>[]) => StructData<T>[]} fn 
	 * @returns {{}) => void} 
	 */
	public update(fn: (data: StructData<T>[]) => StructData<T>[]) {
		this.apply(fn(this.data));
	}
}

/**
 * Writable store that holds a single StructData item and allows updates to it.
 * This is useful for managing a single piece of data that can be updated and subscribed to.
 * For example, it can be used to manage a single user profile or settings.
 * This differs from the StructData class in that it is a writable store and is meant to be used in a reactive context.
 * This differs from the StructDataProxy in that it does not proxy the data and is meant to be used in a reactive context.
 * 
 * @example When you initialize a SingleWritable, you can pass in a default data object (guest user)
 * 	And then once the user data is retrieved from the server, you can set the data using `set` method and the subscribers will be notified.
 *
 * @export
 * @class SingleWritable
 * @typedef {SingleWritable}
 * @template {Blank} T 
 * @implements {Writable<StructData<T>>}
 */
export class SingleWritable<T extends Blank> implements Writable<StructData<T>> {
	/**
	 * The current data held by this writable store.
	 *
	 * @private
	 * @type {StructData<T>}
	 */
	private data: StructData<T>;

	/**
	 * Creates an instance of SingleWritable.
	 *
	 * @constructor
	 * @param {StructData<T>} defaultData 
	 */
	constructor(defaultData: StructData<T>) {
		this.data = defaultData;
	}
	/**
	 * Runs when all subscribers have been removed
	 *
	 * @private
	 * @type {?() => void}
	 */
	private _onAllUnsubscribe?: () => void;
	/**
	 *  A set of subscribers that will be notified when the data changes.
	 *
	 * @private
	 * @readonly
	 * @type {*}
	 */
	private readonly subscribers = new Set<(data: StructData<T>) => void>();

	/**
	 * Subscribes to changes in the data.
	 *
	 * @param {(data: StructData<T>) => void} fn 
	 * @returns {void) => () => void} 
	 */
	subscribe(fn: (data: StructData<T>) => void) {
		this.subscribers.add(fn);
		fn(this.data);
		return () => {
			this.subscribers.delete(fn);
			if (!this.subscribers.size) this._onAllUnsubscribe?.();
		};
	}

	/**
	 * Sets a callback that runs when all subscribers have unsubscribed.
	 *
	 * @param {() => void} fn 
	 * @returns {void) => void} 
	 */
	onAllUnsubscribe(fn: () => void) {
		this._onAllUnsubscribe = fn;
	}

	/**
	 * Sets the data to a new value and notifies all subscribers.
	 *
	 * @param {StructData<T>} data 
	 */
	set(data: StructData<T>) {
		this.data = data;
		this.subscribers.forEach((fn) => fn(data));
	}

	/**
	 * Updates the data using a function that receives the current data.
	 *
	 * @param {(data: StructData<T>) => StructData<T>} fn 
	 * @returns {StructData<T>) => void} 
	 */
	update(fn: (data: StructData<T>) => StructData<T>) {
		this.set(fn(this.data));
	}

	/**
	 * Returns the current data held by this writable store.
	 *
	 * @returns {StructData<T>} 
	 */
	get() {
		return this.data;
	}
}

/**
 * Stream of StructData
 *
 * @export
 * @class StructStream
 * @typedef {StructStream}
 * @template {Blank} T
 * @extends {Stream<StructData<T>>}
 */
export class StructStream<T extends Blank> extends Stream<StructData<T>> {
	/**
	 * Creates an instance of StructStream.
	 *
	 * @constructor
	 * @param {Struct<T>} struct
	 */
	constructor(public readonly struct: Struct<T>) {
		super();
	}
}

/**
 * All events that can be received from the server
 *
 * @export
 * @typedef {StructEvents}
 * @template {Blank} T
 */
export type StructEvents<T extends Blank> = {
	new: [StructData<T>];
	update: [StructData<T>];
	delete: [StructData<T>];
	archive: [StructData<T>];
	restore: [StructData<T>];

	connect: void;
};

/**
 * All read types that can be used to query data
 *
 * @typedef {ReadTypes}
 */
type ReadTypes = {
	all: void;
	archived: void;
	property: {
		key: string;
		value: unknown;
	};
	universe: string;
	custom: {
		query: string;
		data: unknown;
	};
};

/**
 * Global columns that are required for all data
 *
 * @typedef {GlobalCols}
 */
export type GlobalCols = {
	id: 'string';
	created: 'date';
	updated: 'date';
	archived: 'boolean';
	attributes: 'string';
	lifetime: 'number';
	canUpdate: 'boolean';
};

/**
 * Struct class that communicates with the server
 *
 * @export
 * @class Struct
 * @typedef {Struct}
 * @template {Blank} T
 */
export class Struct<T extends Blank> {
	/**
	 * A changable function that can be used to get the current date.
	 * This is used for syncing date with the server through NTP
	 *
	 * @returns {*} 
	 */
	public static getDate: () => number = () => Date.now(); // can be changed for syncing

	/**
	 * Headers that are sent with every request to the server from the struct
	 *
	 * @public
	 * @static
	 * @readonly
	 * @type {*}
	 */
	public static readonly headers = new Map<string, string>();
	/**
	 * All structs that are accessible
	 *
	 * @public
	 * @static
	 * @readonly
	 * @type {*}
	 */
	public static readonly structs = new Map<string, Struct<Blank>>();

	/**
	 * Iterates over all structs and runs a function on each one.
	 *
	 * @public
	 * @static
	 * @param {(struct: Struct<Blank>) => void} fn 
	 * @returns {void) => void} 
	 */
	public static each(fn: (struct: Struct<Blank>) => void) {
		for (const struct of Struct.structs.values()) {
			fn(struct);
		}
	}

	/**
	 * Builds all structs that are registered in the system.
	 *
	 * @public
	 * @static
	 */
	public static buildAll() {
		Struct.each((s) => s.build().then((res) => res.isErr() && console.error(res.error)));
	}

	/**
	 * Cached writables for automatic updating
	 *
	 * @private
	 * @readonly
	 * @type {*}
	 */
	private readonly writables = new Map<string, DataArr<T>>();

	/**
	 * Event emitter for all events
	 *
	 * @private
	 * @readonly
	 * @type {*}
	 */
	private readonly emitter = new ComplexEventEmitter<StructEvents<T>>();

	/**
	 * Whether to cache updates for this struct.
	 *
	 * @public
	 * @readonly
	 * @type {boolean}
	 */
	public readonly cacheUpdates: boolean;

	/**
	 * Listens to an event
	 *
	 * @public
	 * @type {*}
	 */
	public readonly on = this.emitter.on.bind(this.emitter);
	/**
	 * Stops listening to an event
	 *
	 * @public
	 * @type {*}
	 */
	public readonly off = this.emitter.off.bind(this.emitter);
	/**
	 * Listens to an event once
	 *
	 * @public
	 * @type {*}
	 */
	public readonly once = this.emitter.once.bind(this.emitter);
	/**
	 * Emits an event
	 *
	 * @public
	 * @type {*}
	 */
	public readonly emit = this.emitter.emit.bind(this.emitter);

	/**
	 * Cache of StructData, used for updates and optimziations
	 *
	 * @private
	 * @readonly
	 * @type {*}
	 */
	private readonly cache = new Map<string, StructData<T>>();

	/**
	 * Creates an instance of Struct.
	 *
	 * @constructor
	 * @param {StructBuilder<T>} data
	 */
	constructor(public readonly data: StructBuilder<T>) {
		Struct.structs.set(data.name, this as any);
		this.cacheUpdates = data.cacheUpdates ?? true; // default to true
	}

	/**
	 * Creates a new data point, if permitted
	 *
	 * @param {Structable<T>} data
	 * @returns {*}
	 */
	new(data: Structable<T>, attributes: string[] = []) {
		return attemptAsync<StatusMessage>(async () => {
			return this.post(DataAction.Create, {
				data,
				attributes
			}).then((r) => r.unwrap().json());
		});
	}

	/**
	 * Updates an existing data point, if permitted
	 * This should never be used in production, just for testing types
	 *
	 * @readonly
	 * @type {StructData<T>}
	 */
	get sample(): StructData<T> {
		throw new Error('Sample is not meant to used at runtime.');
	}

	/**
	 * Returns a sample of the struct data, which is a StructData object
	 * This is used for testing and development purposes only.
	 *
	 * @readonly
	 * @type {StructDataVersion<T>}
	 */
	get vhSample(): StructDataVersion<T> {
		throw new Error('vhSample is not meant to be used at runtime');
	}

	/**
	 * Sets listeners for the struct. Runs when the struct is built
	 *
	 * @private
	 * @returns {*}
	 */
	private setListeners() {
		return attempt(() => {
			this.data.socket.on(`struct:${this.data.name}`, (data) => {
				this.log('Event Data:', data);
				if (typeof data !== 'object' || data === null) {
					return console.error('Invalid data:', data);
				}
				if (!Object.hasOwn(data, 'event')) {
					return console.error('Invalid event:', data);
				}
				if (!Object.hasOwn(data, 'data')) {
					return console.error('Invalid data:', data);
				}
				const { event, data: structData } = data as {
					event: 'create' | 'update' | 'archive' | 'delete' | 'restore';
					data: PartialStructable<T & GlobalCols>;
				};
				const { id } = structData;

				this.log('Event:', event);
				this.log('Data:', structData);

				if (!id) throw new Error('Data must have an id');

				match(event)
					.case('archive', () => {
						this.log('Archive:', structData);
						const d = this.cache.get(id);
						if (d) {
							d.set({
								...d.data,
								archived: true
							});
							this.emit('archive', d);
						}
					})
					.case('create', () => {
						this.log('Create:', structData);
						const exists = this.cache.get(id);
						if (exists) return;
						const d = new StructData(this, structData);
						this.cache.set(id, d);
						this.emit('new', d);
					})
					.case('delete', () => {
						this.log('Delete:', structData);
						const d = this.cache.get(id);
						if (d) {
							this.cache.delete(id);
							this.log('Deleted:', d.data);
							this.emit('delete', d);
						}
					})
					.case('restore', () => {
						this.log('Restore:', structData);
						const d = this.cache.get(id);
						if (d) {
							d.set({
								...d.data,
								archived: false
							});
							this.emit('restore', d);
						}
					})
					.case('update', () => {
						this.log('Update:', structData);
						const d = this.cache.get(id);
						if (d) {
							this.log('Data exists, updating');
							d.set(structData);
							this.emit('update', d);
						} else {
							this.log('Data does not exist, creating');
							const d = new StructData(this, structData);
							this.cache.set(id, d);
							this.emit('new', d);
						}
					})
					.default(() => console.error('Invalid event:', event))
					.exec();
			});
		});
	}

	/**
	 * Generates a StructData object from the given data, or returns the cached version if it exists.
	 *
	 * @param {(PartialStructable<T & GlobalCols>)} data
	 * @returns {StructData<T>}
	 */
	Generator(data: PartialStructable<T & GlobalCols>): StructData<T>;
	/**
	 * Generates an array of StructData from an array of data, or returns the cached versions if they exist
	 *
	 * @param {PartialStructable<T & GlobalCols>[]} data 
	 * @returns {StructData<T>[]} 
	 */
	Generator(data: PartialStructable<T & GlobalCols>[]): StructData<T>[];
	/**
	 * Generates a StructData object or an array of StructData from the given data.
	 *
	 * @param {(PartialStructable<T & GlobalCols> | PartialStructable<T & GlobalCols>[])} data 
	 * @returns {(StructData<T> | StructData<T>[])} 
	 */
	Generator(data: PartialStructable<T & GlobalCols> | PartialStructable<T & GlobalCols>[]): StructData<T> | StructData<T>[] {
		if (Array.isArray(data)) {
			return data.map((d) => this.Generator(d)) as StructData<T>[];
		}
		if (Object.hasOwn(data, 'id')) {
			const id = (data as { id: string }).id;
			if (this.cache.has(id)) {
				return this.cache.get(id) as StructData<T>;
			}
		}

		// TODO: Data validation
		const d = new StructData(this, data);

		if (Object.hasOwn(data, 'id')) {
			this.cache.set(data.id as string, d as any);
		}

		return d;
	}

	/**
	 * Creates a StructDataProxy from the given data.
	 *
	 * @param {StructData<T & GlobalCols>} data 
	 * @returns {StructDataProxy<T & GlobalCols>} 
	 */
	Proxy(data: StructData<T & GlobalCols>) {
		return new StructDataProxy(data);
	}

	/**
	 * Validates the data
	 *
	 * @param {unknown} data
	 * @returns {(data is PartialStructable<T & GlobalCols>)}
	 */
	validate(data: unknown): data is PartialStructable<T & GlobalCols> {
		if (typeof data !== 'object' || data === null) return false;
		for (const key in data) {
			if (!Object.hasOwn(this.data.structure, key)) return false;
			const type = this.data.structure[key];
			const value = (data as any)[key];
			if (typeof value === 'undefined') continue; // likely does not have permission to read
			if (typeof value !== type) return false;
		}

		return true;
	}

	/**
	 * Generates a Zod schema for the struct data.
	 *
	 * @param {?{
	 * 		optionals?: ((keyof T & keyof GlobalCols) | string)[];
	 * 		not?: ((keyof T & keyof GlobalCols) | string)[];
	 * 	}} [config] 
	 * @returns {*} 
	 */
	getZodSchema(config?: {
		optionals?: ((keyof T & keyof GlobalCols) | string)[];
		not?: ((keyof T & keyof GlobalCols) | string)[];
	}) {
		const createSchema = (key: keyof T & keyof GlobalCols, type: z.ZodType) => {
			if (config?.optionals?.includes(key)) return [key, type.optional()];
			return [key, type];
		};

		return z.object({
			...Object.fromEntries(
				Object.entries({
					...this.data.structure,
					id: 'string',
					created: 'date',
					updated: 'date',
					archived: 'boolean',
					attributes: 'string',
					lifetime: 'number',
					canUpdate: 'boolean'
				}).map(([key, value]) => {
					if (config?.not?.includes(key as any)) return [];
					switch (value) {
						case 'string':
							return createSchema(key as any, z.string());
						case 'number':
							return createSchema(key as any, z.number());
						case 'boolean':
							return createSchema(key as any, z.boolean());
						case 'array':
							return createSchema(key as any, z.array(z.unknown()));
						case 'json':
							return createSchema(key as any, z.string());
						case 'date':
							return createSchema(key as any, z.string());
						case 'bigint':
							return createSchema(key as any, z.bigint());
						case 'custom':
							return createSchema(key as any, z.unknown());
						case 'buffer':
							return createSchema(key as any, z.unknown());
						default:
							return [];
					}
				})
			)
		});
	}

	/**
	 * Sends a post request to the server
	 *
	 * @param {(DataAction | PropertyAction)} action
	 * @param {unknown} data
	 * @returns {*}
	 */
	post(action: DataAction | PropertyAction | string, data: unknown, date?: Date) {
		return attemptAsync(async () => {
			if (!this.data.browser)
				throw new StructError(
					'Currently not in a browser environment. Will not run a fetch request'
				);
			let id = uuid();
			if ((![
				PropertyAction.Read,
				PropertyAction.ReadArchive,
				PropertyAction.ReadVersionHistory,
			].includes(action as PropertyAction) &&
			action !== `${PropertyAction.Read}/custom` &&
			!action.startsWith('custom')
		)) {
				// this is an update, so set up batch updating
				saveStructUpdate({
					struct: this.data.name,
					data,
					id,
					type: action,
				}).unwrap();
			}
			if (BATCH_TEST) {
				throw new Error('Batch test is enabled, will not run a fetch request');
			}
			const res = await fetch(`/struct/${this.data.name}/${action}`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...Object.fromEntries(Struct.headers.entries()),
					'X-Date': String(date?.getTime() || Struct.getDate()),
				},
				body: JSON.stringify(data)
			});

			if (res.ok) {
				deleteStructUpdate(id).unwrap();
			}

			this.log('Post:', action, data, res);
			return res;
		});
	}

	/**
	 * Builds the struct
	 *
	 * @returns {*}
	 */
	build() {
		return attemptAsync(async () => {
			this.log('Building struct:', this.data.name);
			const connect = (await this.connect()).unwrap();
			if (!connect.success) {
				this.log('Failed to connect to struct:', this.data.name);
				throw new FatalStructError(connect.message);
			}

			this.setListeners().unwrap();
		});
	}

	/**
	 * Connects to the backend struct, confirming the front end and backend types are valid
	 *
	 * @returns {*}
	 */
	connect() {
		return attemptAsync<{
			success: boolean;
			message: string;
		}>(async () => {
			this.log('Connecting to struct:', this.data.name);
			const res = await fetch(`/struct/${this.data.name}/connect`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					structure: this.data.structure
				})
			}).then((r) => r.json());
			if (!res.success) {
				throw new FatalStructError(res.message);
			}
			return res;
		});
	}

	/**
	 * Retrieves a stream of data from the server, used for querying data
	 *
	 * @private
	 * @template {keyof ReadTypes} K
	 * @param {K} type
	 * @param {ReadTypes[K]} args
	 * @returns {StructStream<T>}
	 */
	public getStream<K extends keyof ReadTypes>(type: K, args: ReadTypes[K]): StructStream<T> {
		this.log('Stream:', type, args);
		const s = new StructStream(this);
		this.post(`${PropertyAction.Read}/${type}`, { args }).then((res) => {
			const response = res.unwrap();
			this.log('Stream Result:', response);

			// if (response.headers.get('Content-Type') === 'application/json') {
				return setTimeout(async () => {
					this.log('Recieved Streamable JSON');
					const data = await response.json();
					this.log('Stream Data:', data);
					const parsed = z.object({
						success: z.boolean(),
						data: z.array(z.unknown()).optional(),
						message: z.string().optional()
					}).parse(data);
					if (!parsed.success) {
						this.log('Stream Error:', parsed);
						return s.end();
					}
					if (parsed.data) {
						for (const d of parsed.data) {
							s.add(this.Generator(d as any));
						}
						s.end();
					}
				});
			// }

			// const reader = response.body?.getReader();
			// if (!reader) {
			// 	return;
			// }

			// this.log('Stream Reader:', reader);

			// let buffer = '';

			// reader.read().then(({ done, value }) => {
			// 	this.log('Stream Read:', done, value);
			// 	const text = new TextDecoder().decode(value);
			// 	let chunks = text.split('\n\n');
			// 	this.log('Stream Chunks:', ...chunks);

			// 	if (buffer) {
			// 		chunks[0] = buffer + chunks[0];
			// 		buffer = '';
			// 	}

			// 	if (!text.endsWith('\n\n')) {
			// 		buffer = chunks.pop() || '';
			// 	}

			// 	chunks = chunks.filter((i) => {
			// 		if (i === 'end') done = true;
			// 		try {
			// 			JSON.parse(i);
			// 			return true;
			// 		} catch {
			// 			return false;
			// 		}
			// 	});

			// 	for (const chunk of chunks) {
			// 		try {
			// 			const data = JSON.parse(decode(chunk));
			// 			this.log('Stream Data:', data);
			// 			s.add(this.Generator(data));
			// 		} catch (error) {
			// 			console.error('Invalid JSON:', chunk);
			// 		}
			// 	}

			// 	if (done) {
			// 		this.log('Stream Done');
			// 		s.end();
			// 	}
			// });
		});
		return s;
	}

	/**
	 * Gets all data as a stream
	 *
	 * @param {true} asStream If true, returns a stream
	 * @returns {StructStream<T>}
	 */
	all(asStream: true): StructStream<T>;
	/**
	 * Gets all data as an svelte store
	 *
	 * @param {false} asStream If false, returns a svelte store
	 * @returns {DataArr<T>}
	 */
	all(asStream: false): DataArr<T>;
	/**
	 * Gets all data as a stream or svelte store
	 *
	 * @param {boolean} asStream Returns a stream if true, svelte store if false
	 * @returns
	 */
	all(asStream: boolean) {
		const getStream = () => this.getStream('all', undefined);
		if (asStream) return getStream();
		const arr = this.writables.get('all');
		if (arr) return arr;
		const newArr = new DataArr(this, [
			...this.cache.values(),
		]);
		this.writables.set('all', newArr);

		const add = (d: StructData<T>) => {
			newArr.add(d);
		};
		const remove = (d: StructData<T>) => {
			newArr.remove(d);
		};
		const update = (d: StructData<T>) => {
			newArr.inform();
		};
		this.on('new', add);
		this.on('delete', remove);
		this.on('archive', remove);
		this.on('restore', add);
		this.on('update', update);

		const stream = getStream();
		stream.once('data', (data) => newArr.set([data]));
		stream.pipe(add);
		newArr.onAllUnsubscribe(() => {
			this.off('new', add);
			this.off('delete', remove);
			this.off('archive', remove);
			this.off('restore', add);
			this.off('update', update);
			this.writables.delete('all');
		});
		return newArr;
	}

	/**
	 * Gets all archived data
	 *
	 * @param {true} asStream If true, returns a stream
	 * @returns {StructStream<T>}
	 */
	archived(asStream: true): StructStream<T>;
	/**
	 * Gets all archived data
	 *
	 * @param {false} asStream If false, returns a svelte store
	 * @returns {DataArr<T>}
	 */
	archived(asStream: false): DataArr<T>;
	/**
	 * Gets all archived data
	 *
	 * @param {boolean} asStream Returns a stream if true, svelte store if false
	 * @returns
	 */
	archived(asStream: boolean) {
		const getStream = () => this.getStream('archived', undefined);
		if (asStream) return getStream();
		const arr = this.writables.get('archived');
		if (arr) return arr;
		const newArr = new DataArr(this, [
			...this.cache.values(),
		].filter(d => d.data.archived));
		this.writables.set('archived', newArr);

		const add = (d: StructData<T>) => {
			newArr.add(d);
		};
		const remove = (d: StructData<T>) => {
			newArr.remove(d);
		};
		const update = (d: StructData<T>) => {
			newArr.inform();
		};
		this.on('delete', remove);
		this.on('archive', add);
		this.on('restore', remove);
		this.on('update', update);

		const stream = getStream();
		stream.once('data', (data) => newArr.set([data]));
		stream.pipe(add);

		newArr.onAllUnsubscribe(() => {
			this.off('delete', remove);
			this.off('archive', add);
			this.off('restore', remove);
			this.off('update', update);
			this.writables.delete('archived');
		});

		return newArr;
	}

	/**
	 * Gets all data with a specific property value
	 *
	 * @param {string} key Property key
	 * @param {unknown} value Property value
	 * @param {true} asStream If true, returns a stream
	 * @returns {StructStream<T>}
	 */
	fromProperty<K extends keyof (T & GlobalCols)>(
		key: K,
		value: ColTsType<(T & GlobalCols)[K]>,
		asStream: true
	): StructStream<T>;
	/**
	 * Gets all data with a specific property value
	 *
	 * @param {string} key Property key
	 * @param {unknown} value Property value
	 * @param {false} asStream If false, returns a svelte store
	 * @returns {DataArr<T>}
	 */
	fromProperty<K extends keyof (T & GlobalCols)>(
		key: K,
		value: ColTsType<(T & GlobalCols)[K]>,
		asStream: false
	): DataArr<T>;
	/**
	 * Gets all data with a specific property value
	 *
	 * @param {string} key Property key
	 * @param {unknown} value Property value
	 * @param {boolean} asStream Returns a stream if true, svelte store if false
	 * @returns
	 */
	fromProperty<K extends keyof (T & GlobalCols)>(
		key: K,
		value: ColTsType<(T & GlobalCols)[K]>,
		asStream: boolean
	) {
		const getStream = () => this.getStream('property', { key: String(key), value });
		if (asStream) return getStream();
		const arr =
			this.writables.get(`property:${String(key)}:${JSON.stringify(value)}`) ||
			new DataArr(this, [
				...this.cache.values(),
			].filter(d => d.data[key] === value));
		this.writables.set(`property:${String(key)}:${JSON.stringify(value)}`, arr);

		const add = (d: StructData<T>) => {
			if ((d.data as any)[key] === value) arr.add(d);
		};
		const remove = (d: StructData<T>) => {
			arr.remove(d);
		};
		const update = (d: StructData<T>) => {
			if ((d.data as any)[key] === value && !arr.data.includes(d)) {
				arr.add(d);
			} else if ((d.data as any)[key] !== value) {
				arr.remove(d);
			} else {
				arr.inform();
			}
		};

		this.on('new', add);
		this.on('archive', remove);
		this.on('restore', add);
		this.on('delete', remove);
		this.on('update', update);

		const stream = getStream();
		stream.once('data', (data) => arr.set([data]));
		stream.pipe(add);

		arr.onAllUnsubscribe(() => {
			this.off('new', add);
			this.off('archive', remove);
			this.off('restore', add);
			this.off('delete', remove);
			this.off('update', update);
			this.writables.delete(`property:${String(key)}:${JSON.stringify(value)}`);
		});
		return arr;
	}

	/**
	 * Gets all data in a specific universe
	 *
	 * @param {string} universe Universe id
	 * @param {true} asStream If true, returns a stream
	 * @returns {StructStream<T>}
	 */
	fromUniverse(universe: string, asStream: true): StructStream<T>;
	/**
	 * Gets all data in a specific universe
	 *
	 * @param {string} universe Universe id
	 * @param {false} asStream If false, returns a svelte store
	 * @returns {DataArr<T>}
	 */
	fromUniverse(universe: string, asStream: false): DataArr<T>;
	/**
	 * Gets all data in a specific universe
	 *
	 * @param {string} universe Universe id
	 * @param {boolean} asStream Returns a stream if true, svelte store if false
	 * @returns
	 */
	fromUniverse(universe: string, asStream: boolean) {
		const getStream = () => this.getStream('universe', universe);
		if (asStream) return getStream();
		const arr = this.writables.get(`universe:${universe}`) || new DataArr(this, [
			...this.cache.values(),
		].filter(d => d.data.universe === universe));
		this.writables.set(`universe:${universe}`, arr);

		const add = (d: StructData<T>) => {
			// TODO: Check if this data is in the universe
			arr.add(d);
		};

		const remove = (d: StructData<T>) => {
			arr.remove(d);
		};

		const update = (d: StructData<T>) => {
			arr.inform();
		};

		this.on('new', add);
		this.on('archive', remove);
		this.on('restore', add);
		this.on('delete', remove);
		this.on('update', update);

		const stream = getStream();
		stream.once('data', (data) => arr.set([data]));
		stream.pipe(add);

		arr.onAllUnsubscribe(() => {
			this.off('new', add);
			this.off('archive', remove);
			this.off('restore', add);
			this.off('delete', remove);
			this.off('update', update);
			this.writables.delete(`universe:${universe}`);
		});
		return arr;
	}

	/**
	 * Gets data from a specific id
	 *
	 * @param {string} id  Id of the data
	 * @returns {*}
	 */
	fromId(id: string) {
		return attemptAsync(async () => {
			const has = this.cache.get(id);
			if (has) return has;
			const res = await this.post(`${PropertyAction.Read}/from-id`, {
				id,
			});
			const data = await res.unwrap().json();
			return this.Generator(data);
		});
	}

	/**
	 * Logs to the console
	 *
	 * @private
	 * @param {...any[]} args
	 */
	public log(...args: any[]) {
		if (this.data.log) {
			console.log(`[${this.data.name}]`, ...args);
		}
	}

	/**
	 * Sends a custom query to the server and returns the results.
	 *
	 * @param {string} query 
	 * @param {unknown} data 
	 * @param {{
	 * 			asStream: true;
	 * 		}} config 
	 * @returns {StructStream<T>} 
	 */
	query(
		query: string,
		data: unknown,
		config: {
			asStream: true;
		}
	): StructStream<T>;
	/**
	 * Sends a custom query to the server and returns the results.
	 *
	 * @param {string} query 
	 * @param {unknown} data 
	 * @param {{
	 * 			asStream: false;
	 * 			satisfies: (data: StructData<T>) => boolean;
	 * 			includeArchive?: boolean; // default is falsy
	 * 		}} config 
	 * @returns {DataArr<T>} 
	 */
	query(
		query: string,
		data: unknown,
		config: {
			asStream: false;
			satisfies: (data: StructData<T>) => boolean;
			includeArchive?: boolean; // default is falsy
		}
	): DataArr<T>;
	/**
	 * Sends a custom query to the server and returns the results.
	 *
	 * @param {string} query 
	 * @param {unknown} data 
	 * @param {{
	 * 			asStream: boolean;
	 * 			satisfies?: (data: StructData<T>) => boolean;
	 * 			includeArchive?: boolean;
	 * 		}} config 
	 * @returns {boolean; includeArchive?: boolean; }): DataArr<...>; }} 
	 */
	query(
		query: string,
		data: unknown,
		config: {
			asStream: boolean;
			satisfies?: (data: StructData<T>) => boolean;
			includeArchive?: boolean;
		}
	) {
		const get = () => {
			return this.getStream('custom', {
				query,
				data
			});
		};
		if (config.asStream) return get();
		const exists = this.writables.get(`custom:${query}:${JSON.stringify(data)}`);
		if (exists) return exists;

		const arr = new DataArr(this, [
			...this.cache.values(),
		].filter(d => config.satisfies?.(d) || false));


		const add = (d: StructData<T>) => {
			if (config.satisfies?.(d)) {
				arr.add(d);
			}
		};

		const remove = (d: StructData<T>) => {
			// if (config.satisfies?.(d)) {
				arr.remove(d);
			// }
		};

		const update = (d: StructData<T>) => {
			if (config.satisfies?.(d)) {
				if (!arr.data.includes(d)) {
					this.log('Adding data to custom query:', d.data);
					arr.add(d);
				} else {
					this.log('Updating data in custom query:', d.data);
					arr.inform();
				}
			} else {
				this.log('Removing data from custom query:', d.data);
				arr.remove(d);
			}
		};

		this.on('new', add);
		if (!config.includeArchive) this.on('restore', add);
		this.on('archive', remove);
		if (!config.includeArchive) this.on('delete', remove);
		const res = get();
		res.once('data', (d) => arr.set([d]));
		res.pipe((d) => arr.add(d));
		this.on('update', update);

		arr.onAllUnsubscribe(() => {
			this.writables.delete(`custom:${query}:${JSON.stringify(data)}`);

			this.off('new', add);
			this.off('restore', add);
			this.off('archive', remove);
			this.off('delete', remove);
			this.off('update', update);
		});

		return arr;
	}

	/**
	 * Sends custom data to the server and returns the result.
	 *
	 * @template T 
	 * @param {string} name 
	 * @param {unknown} data 
	 * @param {z.ZodType<T>} returnType 
	 * @returns {*} 
	 */
	send<T>(name: string, data: unknown, returnType: z.ZodType<T>) {
		return attemptAsync<T>(async () => {
			const res = await this.post(`custom/${name}`, data).then((r) => r.unwrap().json());
			const parsed = z.object({
				success: z.boolean(),
				data: z.unknown(),
				message: z.string().optional()
			}).parse(res);
			if (!parsed.success) {
				throw new DataError(parsed.message || 'Failed to send data');
			}
			if (!parsed.data) {
				throw new DataError('No data returned');
			}
			return returnType.parse(parsed.data);
		});
	}

	// custom functions
	/**
	 * Calls a custom event on the server and returns the result.
	 *
	 * @param {string} event 
	 * @param {unknown} data 
	 * @returns {*} 
	 */
	call(event: string, data: unknown) {
		return attemptAsync(async () => {
			const res = await (
				await this.post(`call/${event}`, data)
			)
				.unwrap()
				.json();

			return z
				.object({
					success: z.boolean(),
					message: z.string().optional(),
					data: z.unknown().optional()
				})
				.parse(res);
		});
	}

	/**
	 * Creates a new DataArr instance with the given data array.d
	 * This does not cache the data, so it is not stored in the writables map.
	 *
	 * @param {?StructData<T>[]} [dataArray] 
	 * @returns {DataArr<T>} 
	 */
	arr(dataArray?: StructData<T>[]) {
		if (!dataArray) {
			dataArray = [];
		}

		return new DataArr(this, dataArray);
	}

	/**
	 * Creates a new DataArr instance with the given data array.
	 * @deprecated Use `arr` instead with the `Generator` method.
	 *
	 * @param {Structable<T & GlobalCols>[]} dataArray 
	 * @returns {DataArr<T>} 
	 */
	arrGenerator(dataArray: Structable<T & GlobalCols>[]) {
		const w = new DataArr(this, dataArray.map((d) => this.Generator(d)));
		setTimeout(() => {
			this.writables.set('all', w);
		});
		w.onAllUnsubscribe(() => {
			this.writables.delete('all');
		});
		return w;
	}
}