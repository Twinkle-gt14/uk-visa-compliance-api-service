import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import * as jwt from "jsonwebtoken";

export interface AuthenticatedUser {
  userId: string;
  tenantId: string;
  role: "hr_admin" | "employee";
  employeeId: string | null;
}

// Express augmentation so req.user is typed at every call site, rather
// than casting `any` in every controller.
declare module "express" {
  interface Request {
    user?: AuthenticatedUser;
  }
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
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice("Bearer ".length)
      : undefined;
    const token = req.cookies?.["uvc_session"] || bearer;

    if (!token) {
      throw new UnauthorizedException("No session.");
    }

    try {
      const payload = jwt.verify(token, this.jwtSecret) as {
        userId: string;
        tenantId: string;
        role?: "hr_admin" | "employee";
        employeeId?: string | null;
      };
      // role/employeeId are absent on tokens issued before this change
      // (still valid until they expire, max 15 minutes out) - treat
      // those as hr_admin, matching every session that existed before
      // employee logins did.
      req.user = {
        userId: payload.userId,
        tenantId: payload.tenantId,
        role: payload.role ?? "hr_admin",
        employeeId: payload.employeeId ?? null,
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
