// Every table in the suite is SQLite, so the engine loads once per test file, before any test builds one.
import { initSqlJs } from './src/testing/sqljs_connection';

beforeAll(() => initSqlJs());
