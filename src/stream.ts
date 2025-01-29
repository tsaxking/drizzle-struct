import type { PgSelect } from 'drizzle-orm/pg-core';
import { Stream } from 'ts-utils/stream';


export const queryStream = <T extends PgSelect>(query: T) => {
	const stream = new Stream();

	setTimeout(async () => {
		let offset = 0;

		let result: unknown[] = [];

		do {
			const res = await query.offset(offset).limit(100);
			offset += 100;
			result = res;

			for (let i = 0; i < result.length; i++) {
				stream.add(result[i]);
			}
		} while (result.length > 0);
	});


	return stream;
};