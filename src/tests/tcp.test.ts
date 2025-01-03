import { describe } from 'vitest';
import { tcpTest } from '../unit-tests';
import { Client, Server } from '../tcp';


describe('TCP Tests', () => {
    const client = new Client('localhost', 8080, 'apiKey');
    const server = new Server('localhost', 8080);

    tcpTest(server, client);
}); 