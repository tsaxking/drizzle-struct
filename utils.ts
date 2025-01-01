import { match } from 'ts-utils/match';
import { ColType } from './types';

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
