import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { test, describe, expect } from 'vitest';
import { Struct } from './back-end';
import { Server, Client } from './tcp';
import { z } from 'zod';
import { ClientAPI, ServerAPI } from './api';

export const tcpTest = (server: Server, client: Client) => {
    
    server.start();
    
    test('TCP', async () => {
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

    });

    test('API', async () => {
        const serverApi = new ServerAPI(server, 'apiKey');
        const clientApi = new ClientAPI(client, 'apiKey');

        await serverApi.init((key) => true, (key, struct, event) => true);

        await clientApi.init();

        serverApi.listen('apitest', (data) => {
            expect(data.data.test).toBe('apitest');
            serverApi.send('apitest', {
                test: 'apitest'
            });
        });

        clientApi.listen('apitest', (data) => {
            expect(data.data.test).toBe('apitest');
        });

        clientApi.send('apitest', {
            test: 'apitest',
        });
    });
};

export const structTest = async (DB: PostgresJsDatabase, struct: Struct) => {
    if (!struct.built) {
        (await struct.build(DB)).unwrap();
    }

    if (!struct.data.structure.name) {
        throw new Error('No name column');
    }

    if (!struct.data.structure.age) {
        throw new Error('No age column');
    }

    if (struct.data.structure.name.config.dataType !== 'string') {
        throw new Error('Name is not a string');
    }

    if (struct.data.structure.age.config.dataType !== 'number') {
        throw new Error('Age is not a number');
    } 

    describe('Struct Init', async () => {
        (await struct.build(DB as any)).unwrap();
    
        test('Test Struct', async () => {
            (await struct.clear()).unwrap();
    
            const testNew = (
                await struct.new({
                    name: 'test',
                    age: 50
                })
            ).unwrap();
    
            expect(testNew.data.name).toBe('test');
            expect(testNew.data.age).toBe(50);
    
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