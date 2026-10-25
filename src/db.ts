import pg from 'pg';
import { DATABASE_URL } from './config.js';

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
pool.on('error', (err) => console.error('[ops pool] idle client error:', err.message));

export async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
