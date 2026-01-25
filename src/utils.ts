import { match } from 'ts-utils/match';
import { type ColType } from './types';
import { attemptAsync } from 'ts-utils/check';
import fs from 'fs';
import { Struct } from './struct';

export const checkStrType = (str: string, type: ColType): boolean => {
	switch (type) {
		case 'string':
			return true;
		case 'number':
			return !Number.isNaN(+str);
		case 'bigint':
			return !Number.isNaN(+str) || BigInt(str).toString() === str;
		case 'boolean':
			return ['y', 'n', '1', '0', 'true', 'false'].includes(str);
		default:
			return false;
	}
};

export const returnType = (str: string, type: ColType) => {
	return match(type)
		.case('string', () => str)
		.case('number', () => +str)
		.case('bigint', () => BigInt(str))
		.case('boolean', () => ['y', '1', 'true'].includes(str))
		.exec()
		.unwrap();
};

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
export const log = (
	logFile: string | undefined,
	data: {
		event: string;
		type: 'info' | 'warn' | 'error';
		message: string;
	}
) => {
	return attemptAsync(async () => {
		if (!logFile) return;
		switch (data.type) {
			case 'info':
				console.log(`[${data.event}] ${data.message}`);
				break;
			case 'warn':
				console.warn(`[${data.event}] ${data.message}`);
				break;
			case 'error':
				console.error(`[${data.event}] ${data.message}`);
				break;
		}
		const timestamp = new Date().toISOString();
		const line = `${timestamp} [${data.event}] ${data.type.toUpperCase()}: ${data.message}\n`;
		return fs.promises.appendFile(logFile, line);
	});
};
/**
 * Error thrown for invalid struct state
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
	constructor(struct: Struct, message: string) {
		super(message);
		this.name = `StructError [${struct.name}]`;
		struct.emit('error', this);
	}
}

/**
 * Error thrown for a fatal struct state - this should crash the program
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
	constructor(struct: Struct, message: string) {
		super(message);
		this.name = `FatalStructError [${struct.name}]`;
		struct.emit('error', this);
	}
}

/**
 * Error thrown for invalid data state
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
	constructor(struct: Struct, message: string) {
		super(message);
		this.name = `DataError [${struct.name}]`;
		struct.emit('error', this);
	}
}

/**
 * Error thrown for a fatal data state - this should crash the program
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
	constructor(struct: Struct, message: string) {
		super(message);
		this.name = `FatalDataError [${struct.name}]`;
		struct.emit('error', this);
	}
}