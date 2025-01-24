import { match } from 'ts-utils/match';
import { type ColType } from './types';
import { attemptAsync } from 'ts-utils/check';
import fs from 'fs';

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
export const log = (logFile: string | undefined, data: {
    event: string;
    type: 'info' | 'warn' | 'error';
    message: string;
}) => {
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