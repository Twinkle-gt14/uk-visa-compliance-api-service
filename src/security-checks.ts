/**
 * Production hardening: rather than silently running with an insecure
 * default (a superuser DB connection that bypasses RLS, or a hardcoded
 * fallback secret), the app refuses to start at all in production if
 * any of these checks fail. Loud and immediate is safer than quiet and
 * wrong - these are exactly the kind of misconfigurations that are
 * easy to ship by accident and expensive to discover later.
 */

const DEV_ONLY_VALUES = new Set([
  "dev-only-change-me",
  "dev-only-change-me-encryption-key",
  "dev-only-change-me-hmac-key",
]);

export function assertProductionSafety(): void {
  if (process.env.NODE_ENV !== "production") return;

  const problems: string[] = [];

  const dbUser = process.env.DB_USER;
  if (!dbUser || dbUser === "postgres") {
    problems.push(
      "DB_USER is unset or 'postgres' - the API must connect as a non-superuser role " +
        "(app_service, created by migrations/002_app_service_role.sql) in production, " +
        "or every Row-Level Security policy is silently bypassed."
    );
  }

  const authDbUser = process.env.AUTH_DB_USER;
  if (!authDbUser || authDbUser === "postgres") {
    problems.push(
      "AUTH_DB_USER is unset or 'postgres' - AuthService must connect as its own " +
        "restricted role (auth_service, created by migrations/004_auth_service_role.sql), " +
        "not a superuser."
    );
  }

  const secretVars = ["JWT_SECRET", "ENCRYPTION_KEY", "NI_HMAC_KEY"];
  for (const name of secretVars) {
    const value = process.env[name];
    if (!value || DEV_ONLY_VALUES.has(value)) {
      problems.push(`${name} is unset or still using its dev-only default value.`);
    }
  }

  if (problems.length) {
    // eslint-disable-next-line no-console
    console.error(
      "\nRefusing to start in production due to unsafe configuration:\n" +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\n"
    );
    process.exit(1);
  }
}
