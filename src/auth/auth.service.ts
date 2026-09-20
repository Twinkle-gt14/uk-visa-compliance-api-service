import { Injectable } from "@nestjs/common";
import * as jwt from "jsonwebtoken";
import { authPool, withTenant } from "../db";
import { DEFAULT_ROLE_PERMISSIONS, combineRoles, tokenRoleFor, type AccessLevel, type TokenRole } from "../access/permissions";

export interface LoginResult {
  ok: boolean;
  token?: string;
  mustChangePassword?: boolean;
  role?: TokenRole;
  roleName?: string;
  permissions?: string[];
  employeeId?: string | null;
  error?: string;
}

export interface JwtPayload {
  userId: string;
  tenantId: string;
  role: TokenRole;
  employeeId: string | null;
  /** Added so services outside AuthService's own connection (e.g.
   * ComplianceService recording who uploaded a document) can show a
   * human-readable "who did this" without ever querying
   * security.credential themselves - AuthService is the one place
   * that's allowed to touch that table (Database Design - Common
   * Platform Standards, Section 4.6), so it embeds the email into the
   * token it issues instead. */
  email: string;
  /** Unix seconds when this session was first created at login - carried
   * forward unchanged by every refresh() reissue below, so it always
   * reflects the *original* sign-in, not the most recent silent renewal.
   * This is what caps total session length; without it, silent refresh
   * alone would let a session renew itself forever. */
  origIat: number;
}

/** How long a session may be kept alive by silent refresh before the
 * person has to sign in again, regardless of how recently it was last
 * refreshed. Independent of the 15-minute access-token expiry itself -
 * that controls how often a refresh has to happen; this controls how
 * many times it's allowed to. */
const ABSOLUTE_SESSION_LIFETIME_SECONDS = 12 * 60 * 60; // 12 hours

/** How long after a token's own 15-minute expiry it can still be renewed. The browser keeps the
 * session cookie much longer than the token so a late renewal (sleeping laptop, background tab) can
 * still happen - but past this window the person has simply been away too long and has to sign in
 * again. Total idle allowance is therefore about 15 + 15 = 30 minutes since the last renewal. */
const IDLE_RENEWAL_GRACE_SECONDS = 15 * 60;

/** Turns a credential row (its primary role, joined, plus any further roles) into the login-token role plus the
 * role names and permissions the front-end uses for menus. A user can hold several roles: the access level is
 * the highest of them and the permissions are all of them combined. A credential with no role_id yet (created
 * by older code) falls back to the built-in defaults for its legacy role. */
function resolveAccess(row: {
  role: string;
  access_level: string | null;
  role_name: string | null;
  permissions: string[] | null;
  extra_roles?: { name: string; access_level: AccessLevel; permissions: string[] | null }[] | null;
}): { role: TokenRole; roleName: string; permissions: string[] } {
  const roles: { access_level: AccessLevel; permissions: string[] | null; name: string }[] = [];
  if (row.access_level) {
    roles.push({ access_level: row.access_level as AccessLevel, permissions: row.permissions, name: row.role_name ?? row.access_level });
  } else {
    const level: AccessLevel = row.role === "employee" ? "employee" : "hr";
    roles.push({ access_level: level, permissions: null, name: level === "employee" ? "Employee" : "HR" });
  }
  for (const r of row.extra_roles ?? []) roles.push({ access_level: r.access_level, permissions: r.permissions, name: r.name });
  const combined = combineRoles(roles);
  return { role: tokenRoleFor(combined.level), roleName: combined.names.join(" + "), permissions: combined.permissions };
}

const ACCOUNT_DEACTIVATED = "This account has been deactivated. Contact your administrator.";

@Injectable()
export class AuthService {
  private readonly jwtSecret = process.env.JWT_SECRET || "dev-only-change-me";

  /**
   * Identity-first login (Technical Architecture Document, Section 6.2):
   * (1) look up email in security.credential — the one deliberate
   * pre-tenant-context lookup, (2) verify the password using pgcrypto's
   * crypt() against the stored bcrypt hash, (3) resolve tenant_id, (4)
   * issue a JWT carrying tenant_id, user_id, role and (for an employee
   * login) which employee it belongs to - the AuthGuard reads all four
   * off every subsequent request, and role+employeeId is what lets
   * attendance/leave enforce "only your own records" server-side
   * rather than trusting the frontend to hide a picker.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    const result = await authPool.query(
      `SELECT c.id, c.tenant_id, c.password_hash, c.role, c.employee_id, c.must_change_password, c.email, c.is_active,
              r.name AS role_name, r.access_level, r.permissions,
              COALESCE((SELECT json_agg(json_build_object('name', x.name, 'access_level', x.access_level, 'permissions', x.permissions))
                         FROM security.credential_role cr JOIN security.role x ON x.id = cr.role_id
                         WHERE cr.credential_id = c.id), '[]'::json) AS extra_roles
       FROM security.credential c
       LEFT JOIN security.role r ON r.id = c.role_id
       WHERE c.email = $1
       AND c.password_hash = crypt($2, c.password_hash)`,
      [email.trim().toLowerCase(), password]
    );

    if (result.rowCount === 0) {
      // Generic message regardless of whether the email or password was
      // wrong — Technical Architecture Document, Section 6.4.
      return { ok: false, error: "Incorrect email or password." };
    }

    const row = result.rows[0];
    if (row.is_active === false) {
      return { ok: false, error: ACCOUNT_DEACTIVATED };
    }
    const access = resolveAccess(row);

    // Employee login only - an hr_admin session has no linked
    // employee_id at all, and is unaffected. Only an Active employee
    // record may sign in; Draft (mid-wizard, or a directly-added
    // employee still pending its Right to Work check - see
    // EmployeeService's own Draft/Active notes), Inactive and Exited
    // are all refused. Checked via the main app_service-authenticated
    // pool/withTenant (the same access pattern EmployeeService itself
    // uses for employee.employee_master), not authPool - auth_service
    // is deliberately locked out of the employee schema entirely
    // (migration 004), so this stays a separate, narrowly-scoped query
    // against the connection that's actually allowed to read it.
    if (row.role === "employee" && row.employee_id && !(await this.isEmployeeActive(row.tenant_id, row.employee_id))) {
      return { ok: false, error: "This employee record is not Active. Contact HR to reactivate it before signing in." };
    }

    const payload: JwtPayload = {
      userId: row.id,
      tenantId: row.tenant_id,
      role: access.role,
      employeeId: row.employee_id,
      email: row.email,
      origIat: Math.floor(Date.now() / 1000),
    };
    const token = jwt.sign(payload, this.jwtSecret, { expiresIn: "15m" });

    return {
      ok: true,
      token,
      mustChangePassword: !!row.must_change_password,
      role: access.role,
      roleName: access.roleName,
      permissions: access.permissions,
      employeeId: row.employee_id,
    };
  }

  /**
   * Silent renewal: called by AuthController's POST /auth/refresh,
   * itself called by the frontend a couple of minutes before its
   * 15-minute access token expires (see uk-visa-shell/lib/auth.tsx),
   * so an active user is never actually signed out mid-task by the
   * access token's short lifetime.
   *
   * Accepts a token that may already be expired - ignoreExpiration is
   * deliberate here, since the whole point is reissuing before (or
   * shortly after) that boundary - but still verifies the signature,
   * so this can't be used to extend a forged or tampered token. What
   * actually bounds how long a session can be kept alive this way is
   * origIat: once ABSOLUTE_SESSION_LIFETIME_SECONDS has passed since
   * the *original* login, refresh stops working and the person has to
   * sign in again, the same as if they'd never refreshed at all.
   *
   * Authorization-relevant fields (role, employeeId, tenantId) are
   * re-read from security.credential here, not copied forward from
   * the old token's payload. The old behaviour trusted whatever the
   * previous token said, which meant (a) a role change or account
   * deactivation made by HR never took effect against an already-live
   * session until its full 12-hour absolute lifetime ran out, and (b)
   * a token that was ever missing its role claim for any reason kept
   * re-minting new "valid" tokens that were also missing it,
   * indefinitely - AuthGuard's handling of a missing role is a
   * separate, defensive fix, but this is the one that actually stops
   * it from happening on every legitimate refresh in the first place.
   */
  async refresh(token: string): Promise<LoginResult> {
    let payload: JwtPayload & { iat: number; exp?: number };
    try {
      payload = jwt.verify(token, this.jwtSecret, { ignoreExpiration: true }) as JwtPayload & { iat: number; exp?: number };
    } catch {
      return { ok: false, error: "Session expired or invalid." };
    }

    // Away too long: the token expired more than the grace window ago.
    if (typeof payload.exp === "number" && Math.floor(Date.now() / 1000) - payload.exp > IDLE_RENEWAL_GRACE_SECONDS) {
      return { ok: false, error: "Session expired due to inactivity. Please sign in again." };
    }

    // Tokens issued before origIat existed have no way to know their
    // true session age - fall back to their own iat rather than
    // treating them as infinitely refreshable.
    const sessionStart = payload.origIat ?? payload.iat;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds - sessionStart > ABSOLUTE_SESSION_LIFETIME_SECONDS) {
      return { ok: false, error: "Session expired. Please sign in again." };
    }

    // Re-fetch current identity/authorization from the source of
    // truth rather than trusting the token being renewed. A row that
    // no longer exists (account deleted) fails the refresh outright,
    // forcing a real re-login rather than silently keeping a deleted
    // account's session alive.
    const result = await authPool.query(
      `SELECT c.tenant_id, c.role, c.employee_id, c.email, c.is_active, r.name AS role_name, r.access_level, r.permissions,
              COALESCE((SELECT json_agg(json_build_object('name', x.name, 'access_level', x.access_level, 'permissions', x.permissions))
                         FROM security.credential_role cr JOIN security.role x ON x.id = cr.role_id
                         WHERE cr.credential_id = c.id), '[]'::json) AS extra_roles
       FROM security.credential c
       LEFT JOIN security.role r ON r.id = c.role_id
       WHERE c.id = $1`,
      [payload.userId]
    );
    if (result.rowCount === 0) {
      return { ok: false, error: "Session expired. Please sign in again." };
    }
    const row = result.rows[0];
    if (row.is_active === false) {
      return { ok: false, error: "Session expired. " + ACCOUNT_DEACTIVATED };
    }
    const access = resolveAccess(row);

    // Same Active-only check as login() - a session refresh is exactly
    // the "already-live session" case that check's own comment is
    // about: HR deactivating this employee mid-session should stop
    // silent renewal working from that point on, not just block the
    // next fresh sign-in.
    if (row.role === "employee" && row.employee_id && !(await this.isEmployeeActive(row.tenant_id, row.employee_id))) {
      return { ok: false, error: "This employee record is not Active. Contact HR to reactivate it before signing in." };
    }

    const newPayload: JwtPayload = {
      userId: payload.userId,
      tenantId: row.tenant_id,
      role: access.role,
      employeeId: row.employee_id,
      email: row.email,
      origIat: sessionStart,
    };
    const newToken = jwt.sign(newPayload, this.jwtSecret, { expiresIn: "15m" });

    return { ok: true, token: newToken, role: access.role, roleName: access.roleName, permissions: access.permissions, employeeId: row.employee_id };
  }

  /** Active-only gate for an employee-role login/refresh - see login()
   * and refresh()'s own comments on why this goes through the main
   * app_service pool/withTenant rather than authPool. A missing or
   * soft-deleted row (should be unreachable in practice, since
   * employee_id on a credential row is only ever set to a real
   * employee) is treated as not active rather than throwing. */
  private async isEmployeeActive(tenantId: string, employeeId: string): Promise<boolean> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT record_status FROM employee.employee_master WHERE id = $1 AND NOT is_deleted`,
        [employeeId]
      );
      return !!result.rowCount && result.rows[0].record_status === "Active";
    });
  }

  /**
   * Called once, from EmployeeService.onboardEmployee() - not exposed
   * as its own HTTP endpoint, since credential provisioning only ever
   * happens as a side effect of onboarding, never on its own. Default
   * password is the employee's id label itself (e.g. "E000001"),
   * flagged must_change_password so the frontend forces a change on
   * first login rather than leaving a guessable password live.
   */
  async createEmployeeCredential(tenantId: string, employeeId: string, email: string, employeeIdLabel: string): Promise<void> {
    // Not using ON CONFLICT here - security.credential's exact
    // constraints aren't visible from this repo (see migration
    // comment), so this checks explicitly rather than assuming a
    // unique index exists on email.
    const existing = await authPool.query("SELECT id FROM security.credential WHERE email = $1", [email.trim().toLowerCase()]);
    if (existing.rowCount) return;
    await authPool.query(
      `INSERT INTO security.credential (tenant_id, email, password_hash, role, employee_id, must_change_password, role_id)
       VALUES ($1, $2, crypt($3, gen_salt('bf')), 'employee', $4, true,
               (SELECT id FROM security.role WHERE tenant_id = $1 AND name = 'Employee'))`,
      [tenantId, email.trim().toLowerCase(), employeeIdLabel, employeeId]
    );
  }

  /** The logged-in user's own password change - old password required
   * even though the JWT already proves who they are, since this is
   * also how the forced first-login change is completed and a stolen
   * *session* alone shouldn't be enough to lock the real owner out. */
  async changeOwnPassword(userId: string, oldPassword: string, newPassword: string): Promise<{ ok: boolean; error?: string }> {
    const result = await authPool.query(
      `UPDATE security.credential
       SET password_hash = crypt($1, gen_salt('bf')), must_change_password = false
       WHERE id = $2 AND password_hash = crypt($3, password_hash)
       RETURNING id`,
      [newPassword, userId, oldPassword]
    );
    if (!result.rowCount) {
      return { ok: false, error: "Current password is incorrect." };
    }
    return { ok: true };
  }
}
