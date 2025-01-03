import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { test, describe, expect } from 'vitest';
import { Struct } from './back-end';
import { text } from 'drizzle-orm/pg-core';
import { Server, Client } from './tcp';
import { z } from 'zod';
import { ClientAPI, ServerAPI } from './api';


const testStructForType = new Struct({
    name: 'test',
    structure: {
        name: text('name').notNull(),
        age: text('age').notNull(),
    },
    sample: true,
});

export const tcpTest = (server: Server, client: Client) => {
    test('TCP', async () => {
        server.start();
    
        client.listen(
            'test',
            ({ data }) => {
                console.log(data);
                expect(data.test).toBe('test');
            },
            z.object({
                test: z.string()
            })
        );
    
        server.listenTo(
            'test',
            'test',
            ({ data }) => {
                expect(data.test).toBe('test');
                server.sendTo(
                    'test',
                    'test',
                    {
                        test: 'test'
                    },
                    Date.now()
                );
            },
            z.object({
                test: z.string()
            })
        );
    
        client.send(
            'test',
            {
                test: 'test'
            },
            Date.now()
        );

        const serverApi = new ServerAPI(server, 'apiKey');
        const clientApi = new ClientAPI(client, 'apiKey');

        await serverApi.init((key) => true, (key, struct, event) => true);

        await clientApi.init();
    });
};

export const structTest = async (DB: PostgresJsDatabase, struct: typeof testStructForType) => {
    if (!struct.built) {
        (await struct.build(DB)).unwrap();
    }

    describe('Struct Init', async () => {
        (await struct.build(DB as any)).unwrap();
    
        test('Test Struct', async () => {
            (await struct.clear()).unwrap();
    
            const testNew = (
                await struct.new({
                    name: 'test',
                    age: 'test'
                })
            ).unwrap();
    
            expect(testNew.data.name).toBe('test');
    
            const selected = (await struct.fromProperty('name', 'test', false)).unwrap();
            if (selected.length === 0) {
                throw new Error('No results found');
            }
    
            const [testSelected] = selected;
            expect(testSelected.data.name).toBe('test');
    
            (
                await testSelected.update({
                    name: 'test2'
                })
            ).unwrap();
    
            const updated = (await struct.fromProperty('name', 'test2', false)).unwrap();
    
            if (updated.length === 0) {
                throw new Error('No results found');
            }
    
            const [testUpdated] = updated;
    
            expect(testUpdated.data.name).toBe('test2');
    
            (await testSelected.delete()).unwrap();
    
            const deleted = (await struct.fromProperty('name', 'test2', false)).unwrap();
    
            expect(deleted.length).toBe(0);
        });
    });
    
};