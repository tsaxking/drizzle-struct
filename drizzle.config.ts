import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';
config();

const { DB_USER, DB_PASS, DB_HOST, DB_PORT, DB_NAME } = process.env;
if (!DB_USER) throw new Error('DB_USER is not defined in environment variables');
if (!DB_PASS) throw new Error('DB_PASS is not defined in environment variables');
if (!DB_HOST) throw new Error('DB_HOST is not defined in environment variables');
if (!DB_PORT) throw new Error('DB_PORT is not defined in environment variables');
if (!DB_NAME) throw new Error('DB_NAME is not defined in environment variables');

export default defineConfig({
	dialect: 'postgresql',
	schema: './src/tests/schema.ts',
	dbCredentials: {
		host: DB_HOST,
		port: parseInt(DB_PORT, 10),
		user: DB_USER,
		password: DB_PASS,
		database: DB_NAME,
		ssl: false
	},
	verbose: true,
	strict: true,
	out: './drizzle'
});
