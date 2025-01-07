import { integer, text } from "drizzle-orm/pg-core";
import { Struct, StructData } from "./back-end";

export namespace CachedEvents {
    export const Events = new Struct({
        name: 'cached_events',
        structure: {
            timestamp: integer('timestamp').notNull(),
            eventId: integer('event_id'),
            event: text('event').notNull(),
            data: text('data'), // json
            apiKey: text('api_key').notNull(),
            tries: integer('tries').notNull(),
        },
    });


    export type EventData = StructData<typeof Events.data.structure, typeof Events.data.name>;
}


export const _events = CachedEvents.Events.table;