import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import * as jwt from "jsonwebtoken";

export interface AuthenticatedUser {
  userId: string;
  tenantId: string;
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
 * AuthService.login) and attaches { userId, tenantId } to the request.
 * This guard did not exist anywhere in the codebase before this work -
 * login previously only issued a token; nothing validated it on
 * subsequent requests. Apply with @UseGuards(AuthGuard) on any
 * controller that should require a signed-in session.
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
      const payload = jwt.verify(token, this.jwtSecret) as { userId: string; tenantId: string };
      req.user = { userId: payload.userId, tenantId: payload.tenantId };
      return true;
    } catch {
      throw new UnauthorizedException("Session expired or invalid.");
    }
  }
}
