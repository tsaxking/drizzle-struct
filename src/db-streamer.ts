import { SQL, Table } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Stream } from "ts-utils/stream";
import { Structable } from "./back-end";

export const dbStream = <T>(db: PostgresJsDatabase, table: Table, query: SQL, config?: {
    batchSize?: number;
    wait?: number;
}) => {
    const stream = new Stream<T>();
    setTimeout(() => {
        let cursor = 0;
        const batchSize = config?.batchSize || 100;
        const fetch = async () => {
            const rows = await db.select().from(table).where(query).limit(batchSize).offset(cursor);
            if (rows.length === 0) {
                stream.end();
            } else {
                for (const row of rows) {
                    stream.add(row as T);
                }
                cursor += batchSize;
                fetch();
            }
        };
    }, config?.wait || 0);
    return stream;
};