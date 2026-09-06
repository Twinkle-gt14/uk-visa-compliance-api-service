import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import * as jwt from "jsonwebtoken";

export interface AuthenticatedUser {
  userId: string;
  tenantId: string;
  role: "hr_admin" | "employee";
  employeeId: string | null;
  /** See JwtPayload's own comment (auth.service.ts) on why this rides
   * along in the token itself rather than being looked up here. Falls
   * back to "" for a token minted before this field existed - self-
   * heals on that session's next silent refresh, which re-mints with
   * a fresh email pulled from security.credential. */
  email: string;
}

// Express augmentation so req.user is typed at every call site, rather
// than casting `any` in every controller.
declare module "express" {
  interface Request {
    user?: AuthenticatedUser;
  }
}

/** Same extraction AuthGuard uses below, pulled out so AuthController's
 * /auth/refresh can read the caller's current token without going
 * through AuthGuard itself - a token that's a few seconds past its
 * 15-minute expiry must still reach AuthService.refresh() (which
 * verifies it with ignoreExpiration and applies its own absolute-
 * session-age check), where AuthGuard would reject it outright. */
export function extractSessionToken(req: Request): string | undefined {
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice("Bearer ".length)
    : undefined;
  return req.cookies?.["uvc_session"] || bearer;
}

/**
 * Validates the uvc_session cookie (the same JWT issued by
 * AuthService.login) and attaches { userId, tenantId, role, employeeId }
 * to the request. Apply with @UseGuards(AuthGuard) on any controller
 * that should require a signed-in session.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly jwtSecret = process.env.JWT_SECRET || "dev-only-change-me";

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const token = extractSessionToken(req);

    if (!token) {
      throw new UnauthorizedException("No session.");
    }

    try {
      const payload = jwt.verify(token, this.jwtSecret) as {
        userId: string;
        tenantId: string;
        role?: "hr_admin" | "employee";
        employeeId?: string | null;
        email?: string;
      };
      // A token with no role claim used to be treated as hr_admin -
      // the more privileged role - on the theory that it could only be
      // a pre-employee-login token, "still valid until they expire,
      // max 15 minutes out". That assumption didn't hold: refresh()
      // used to carry the old payload's role forward unchanged into
      // each newly-minted token, so a session that ever lost its role
      // claim kept reissuing role-less tokens indefinitely, each one
      // silently upgraded to hr_admin here, well past 15 minutes.
      // refresh() now re-reads role fresh from security.credential on
      // every renewal (see AuthService.refresh), so a legitimate
      // session should never actually hit this case going forward;
      // this now fails closed instead of failing open, so a token that
      // does turn up without one is rejected rather than trusted with
      // the more powerful role by default.
      if (!payload.role) {
        throw new UnauthorizedException("Session expired or invalid.");
      }
      req.user = {
        userId: payload.userId,
        tenantId: payload.tenantId,
        role: payload.role,
        employeeId: payload.employeeId ?? null,
        email: payload.email ?? "",
      };
      return true;
    } catch {
      throw new UnauthorizedException("Session expired or invalid.");
    }
  }
}

/** Throws if an employee-role session is trying to touch a record that
 * isn't their own. hr_admin sessions are never restricted by this -
 * call it at the top of any attendance/leave handler that takes a
 * target employeeId, before any data access happens. 403, not 401 -
 * the session itself is perfectly valid, it just isn't permitted this
 * particular record; a 401 here would be wrong (and could trip a
 * generic "401 -> log out" interceptor into signing out someone who
 * did nothing wrong). */
export function assertSelfOrHrAdmin(user: AuthenticatedUser, targetEmployeeId: string) {
  if (user.role === "hr_admin") return;
  if (user.employeeId !== targetEmployeeId) {
    throw new ForbiddenException("You can only access your own records.");
  }
}

/** Everything that isn't Attendance or Leave (Employees, Compliance,
 * Settings, Payslip, ...) is HR-only - an employee-role session has no
 * legitimate reason to hit any of it, including read-only endpoints
 * like listing every employee. Apply alongside AuthGuard:
 * @UseGuards(AuthGuard, HrAdminGuard). Must run after AuthGuard (Nest
 * evaluates in array order) so req.user is already populated. 403, not
 * 401 - see assertSelfOrHrAdmin's comment above, same reasoning. */
@Injectable()
export class HrAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.user?.role !== "hr_admin") {
      throw new ForbiddenException("This area is only available to HR/admin users.");
    }
    return true;
  }
}
