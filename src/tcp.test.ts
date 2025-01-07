import { describe, it, expect, vi, beforeEach } from 'vitest';
import net from 'net';
import { Client, Server, ClientConnection, Events } from './tcp';import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { Struct } from './back-end';

export const structTest = async (DB: PostgresJsDatabase, struct: Struct) => {
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

    (await struct.build(DB as any)).unwrap();

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

    return true;
};

vi.mock('net', () => ({
  createConnection: vi.fn(),
  createServer: vi.fn(() => ({
    listen: vi.fn(),
    on: vi.fn(),
  })),
}));

describe('TCPEventHandler', () => {
  let mockSocket: net.Socket;

  beforeEach(() => {
    mockSocket = {
      write: vi.fn().mockReturnValue(true),
      on: vi.fn(),
      end: vi.fn(),
    } as unknown as net.Socket;
  });

  it('should emit connect when connected', () => {
    const client = new Client(8080, 'localhost', 'test-key');
    const connectSpy = vi.fn();
    client.on('connect', connectSpy);

    // Simulate socket connection
    mockSocket.on('connect', vi.fn());
    expect(connectSpy).toHaveBeenCalled();
  });

  it('should attempt reconnection on disconnection', () => {
    const client = new Client(8080, 'localhost', 'test-key');
    const reconnectSpy = vi.fn();
    client.on('reconnect_attempt', reconnectSpy);

    // Simulate socket disconnection
    mockSocket.on('close', vi.fn());
    expect(reconnectSpy).toHaveBeenCalled();
  });
});

describe('Server', () => {
  let server: Server;
  const testKey = async (key: string) => key === 'valid-key';

  beforeEach(() => {
    server = new Server( 'localhost', 8080, testKey);
  });

  it('should handle new client connections', () => {
    const clientConnectedSpy = vi.fn();
    server.on('client_connected', clientConnectedSpy);

    // Simulate a new client connection
    const mockSocket = { on: vi.fn(), end: vi.fn() } as unknown as net.Socket;
    server['handleNewConnection'](mockSocket);

    // Simulate client identification
    const connection = new ClientConnection(mockSocket, server);
    connection.send('i_am', 'valid-key');
    expect(clientConnectedSpy).toHaveBeenCalledWith('valid-key');
  });

  it('should reject invalid keys', () => {
    const mockSocket = { on: vi.fn(), end: vi.fn() } as unknown as net.Socket;

    server['handleNewConnection'](mockSocket);
    const connection = new ClientConnection(mockSocket, server);
    connection.send('i_am', 'invalid-key');

    expect(mockSocket.end).toHaveBeenCalled();
  });
});

describe('Event Handling', () => {
  let handler: any;
  let mockSocket: net.Socket;

  const server = new Server('localhost', 8081, () => true);

  beforeEach(() => {
    mockSocket = {
      write: vi.fn().mockReturnValue(true),
      on: vi.fn(),
      end: vi.fn(),
    } as unknown as net.Socket;
    handler = new ClientConnection(mockSocket, server);
  });

  it('should send an event correctly', () => {
    const event = { test: 'data' };
    handler.send('test', event);

    expect(mockSocket.write).toHaveBeenCalledWith(JSON.stringify({
      event: 'test',
      data: event,
    }));
  });

  it('should retry events if not acknowledged', () => {
    const loopSpy = vi.fn();
    handler['loop'] = {
      start: loopSpy,
      stop: vi.fn(),
    };
    handler['cache'].set(1, { tries: 4 });

    handler['loop'].start();
    expect(loopSpy).toHaveBeenCalled();
  });
});

// describe('Cached Events', () => {
//   it('should save events to cache', async () => {
//     const event = new Event('test', { test: 'data' }, Date.now(), 1);
//     const saveSpy = vi.spyOn(event, 'save');

//     await event.save();
//     expect(saveSpy).toHaveBeenCalled();
//   });

//   it('should delete events from cache', async () => {
//     const event = new Event('test', { test: 'data' }, Date.now(), 1);
//     const deleteSpy = vi.spyOn(event, 'delete');

//     await event.delete();
//     expect(deleteSpy).toHaveBeenCalled();
//   });
// });
