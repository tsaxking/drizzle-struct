import { NotNull, Table } from 'drizzle-orm';
import { Struct } from '../struct';
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

type TestSchema = Struct<{
	string: NotNull<ReturnType<typeof text>>;
	boolean: NotNull<ReturnType<typeof boolean>>;
	integer: NotNull<ReturnType<typeof integer>>;
	real: NotNull<ReturnType<typeof real>>;
	char: NotNull<ReturnType<typeof char>>;
	timestamp: NotNull<ReturnType<typeof timestamp>>;
	varchar: NotNull<ReturnType<typeof varchar>>;
	date: NotNull<ReturnType<typeof date>>;
	// pgEnum: NotNull<ReturnType<typeof pgEnum>>;
}>;

export const struct: TestSchema = new Struct({
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
}) as TestSchema;

export const _table: Table = struct.table;
export const _versionTable: Table | undefined = struct.versionTable;
