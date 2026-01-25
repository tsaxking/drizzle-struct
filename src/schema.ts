import { Struct } from './struct';
import {
	text,
	boolean,
	timestamp,
	integer,
	char,
	date,
	/* pgEnum, */ varchar,
	real
} from 'drizzle-orm/pg-core';

export const struct = new Struct({
	name: 'test',
	structure: {
		string: text('string').notNull(),
		boolean: boolean('boolean').notNull(),
		integer: integer('integer').notNull(),
		real: real('real').notNull(),
		char: char('char', { length: 1 }).notNull(),
		timestamp: timestamp('timestamp').notNull(),
		varchar: varchar('varchar', { length: 255 }).notNull(),
		date: date('date').notNull()
		// pgEnum: pgEnum('pg_enum', ['option1', 'option2', 'option3']),
	},
	versionHistory: {
		amount: 5,
		type: 'versions'
	}
});

export const _table = struct.table;
export const _versionTable = struct.versionTable;
