import { integer, text } from 'drizzle-orm/pg-core';
import { Blank, Struct, StructData } from './back-end';

export namespace CachedEvents {
	export const Events: any = new Struct({
		name: 'cached_events',
		structure: {
			timestamp: integer('timestamp').notNull(),
			eventId: integer('event_id'),
			event: text('event').notNull(),
			payload: text('payload'), // json
			apiKey: text('api_key').notNull(),
			tries: integer('tries').notNull()
		}
	});

	export type EventData = StructData<typeof Events.data.structure, typeof Events.data.name>;
}

export const _events: any = CachedEvents.Events.table;
