import { Pool } from "pg";

/**
 * Connects to PgBouncer's sidecar on localhost — NOT directly to Cloud SQL.
 * The sidecar is what actually reaches Cloud SQL's private IP over the
 * VPC connector; the API container only ever talks to 127.0.0.1:6432.
 * See Technical Architecture Document, Section 7.2 (corrected).
 */
export const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 6432),
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "uk_visa_compliance",
  max: 5,
});

/**
 * Separate connection pool for AuthService, using its own auth_service
 * role (read-only on security.credential, no access to employee/
 * reference schemas - see migrations/004_auth_service_role.sql). Kept
 * distinct from `pool` above (which uses app_service, scoped the
 * opposite way) rather than sharing one connection that would need
 * broader access than either individual module actually requires.
 */
export const authPool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 6432),
  user: process.env.AUTH_DB_USER || "postgres",
  password: process.env.AUTH_DB_PASSWORD,
  database: process.env.DB_NAME || "uk_visa_compliance",
  max: 5,
});

/**
 * Runs `fn` inside a transaction with app.current_tenant_id set via
 * SET LOCAL, so every Row-Level Security policy in the employee schema
 * (Database Design - Common Platform Standards, Section 3.3-3.4) scopes
 * queries to the caller's own tenant automatically - no query in `fn`
 * needs to (or should) filter by tenant_id itself. Requires PgBouncer
 * in session pooling mode; transaction pooling would silently break
 * SET LOCAL (per the Phase 2 Data Layer & Auth Guide's troubleshooting
 * notes on this exact point).
 *
 * NOTE: the API currently connects as DB_USER=postgres (superuser),
 * not the app_service role the platform standard specifies (Section
 * 4.6) - RLS is enabled either way, but a superuser bypasses it by
 * default in Postgres. Switching the connection to a real app_service
 * role (granted BYPASSRLS=false) is a prerequisite for RLS to actually
 * enforce anything here, and should happen before this goes further
 * than local verification.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (client: import("pg").PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
