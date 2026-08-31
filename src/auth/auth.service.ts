import { Injectable } from "@nestjs/common";
import * as jwt from "jsonwebtoken";
import { authPool } from "../db";

export interface LoginResult {
  ok: boolean;
  token?: string;
  mustChangePassword?: boolean;
  role?: "hr_admin" | "employee";
  employeeId?: string | null;
  error?: string;
}

export interface JwtPayload {
  userId: string;
  tenantId: string;
  role: "hr_admin" | "employee";
  employeeId: string | null;
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
      `SELECT id, tenant_id, password_hash, role, employee_id, must_change_password
       FROM security.credential
       WHERE email = $1
       AND password_hash = crypt($2, password_hash)`,
      [email.trim().toLowerCase(), password]
    );

    if (result.rowCount === 0) {
      // Generic message regardless of whether the email or password was
      // wrong — Technical Architecture Document, Section 6.4.
      return { ok: false, error: "Incorrect email or password." };
    }

    const row = result.rows[0];
    const payload: JwtPayload = {
      userId: row.id,
      tenantId: row.tenant_id,
      role: row.role,
      employeeId: row.employee_id,
      origIat: Math.floor(Date.now() / 1000),
    };
    const token = jwt.sign(payload, this.jwtSecret, { expiresIn: "15m" });

    return { ok: true, token, mustChangePassword: !!row.must_change_password, role: row.role, employeeId: row.employee_id };
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
   */
  async refresh(token: string): Promise<LoginResult> {
    let payload: JwtPayload & { iat: number };
    try {
      payload = jwt.verify(token, this.jwtSecret, { ignoreExpiration: true }) as JwtPayload & { iat: number };
    } catch {
      return { ok: false, error: "Session expired or invalid." };
    }

    // Tokens issued before origIat existed have no way to know their
    // true session age - fall back to their own iat rather than
    // treating them as infinitely refreshable.
    const sessionStart = payload.origIat ?? payload.iat;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds - sessionStart > ABSOLUTE_SESSION_LIFETIME_SECONDS) {
      return { ok: false, error: "Session expired. Please sign in again." };
    }

    const newPayload: JwtPayload = {
      userId: payload.userId,
      tenantId: payload.tenantId,
      role: payload.role,
      employeeId: payload.employeeId,
      origIat: sessionStart,
    };
    const newToken = jwt.sign(newPayload, this.jwtSecret, { expiresIn: "15m" });

    return { ok: true, token: newToken, role: payload.role, employeeId: payload.employeeId };
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
      `INSERT INTO security.credential (tenant_id, email, password_hash, role, employee_id, must_change_password)
       VALUES ($1, $2, crypt($3, gen_salt('bf')), 'employee', $4, true)`,
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
