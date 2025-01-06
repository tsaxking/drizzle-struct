import { integer, text } from "drizzle-orm/pg-core";
import { Struct, StructData } from "./back-end";

export namespace CachedEvents {
    export const Events = new Struct({
        name: 'cached_events',
        structure: {
            timestamp: integer('timestamp'),
            eventId: integer('event_id').unique(),
            event: text('event'),
            data: text('data'), // json
        },
    });


    export type EventData = StructData<typeof Events.data.structure, typeof Events.data.name>;
}


export const _events = CachedEvents.Events.table;