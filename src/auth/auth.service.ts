import { Injectable } from "@nestjs/common";
import * as jwt from "jsonwebtoken";
import { authPool } from "../db";

export interface LoginResult {
  ok: boolean;
  token?: string;
  error?: string;
}

@Injectable()
export class AuthService {
  private readonly jwtSecret = process.env.JWT_SECRET || "dev-only-change-me";

  /**
   * Identity-first login (Technical Architecture Document, Section 6.2):
   * (1) look up email in security.credential — the one deliberate
   * pre-tenant-context lookup, (2) verify the password using pgcrypto's
   * crypt() against the stored bcrypt hash, (3) resolve tenant_id, (4)
   * issue a JWT carrying both tenant_id and user_id.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    const result = await authPool.query(
      `SELECT id, tenant_id, password_hash
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
    const token = jwt.sign(
      { userId: row.id, tenantId: row.tenant_id },
      this.jwtSecret,
      { expiresIn: "15m" }
    );

    return { ok: true, token };
  }
}
