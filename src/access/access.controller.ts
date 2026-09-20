import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AdminGuard, AuthGuard } from "../auth/auth.guard";
import { AccessService } from "./access.service";

/** Everything here is Admin-only: managing users and the roles (and their permissions) they're given. */
@Controller("access")
@UseGuards(AuthGuard, AdminGuard)
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Get("permissions")
  permissions() {
    return this.access.listPermissions();
  }

  @Get("roles")
  roles(@Req() req: Request) {
    return this.access.listRoles(req.user!.tenantId);
  }

  @Post("roles")
  createRole(@Req() req: Request, @Body() body: { name: string; description?: string; accessLevel: string; permissions: string[] }) {
    return this.access.createRole(req.user!.tenantId, body);
  }

  @Patch("roles/:id")
  updateRole(@Req() req: Request, @Param("id") id: string, @Body() body: { name?: string; description?: string; permissions?: string[] }) {
    return this.access.updateRole(req.user!.tenantId, id, body);
  }

  @Delete("roles/:id")
  deleteRole(@Req() req: Request, @Param("id") id: string) {
    return this.access.deleteRole(req.user!.tenantId, id);
  }

  @Get("employees")
  employees(@Req() req: Request) {
    return this.access.listEmployees(req.user!.tenantId);
  }

  @Get("users")
  users(@Req() req: Request) {
    return this.access.listUsers(req.user!.tenantId);
  }

  @Post("roles/:id/users")
  attachUser(@Req() req: Request, @Param("id") id: string, @Body() body: { employeeId: string }) {
    return this.access.attachUser(req.user!.tenantId, id, body.employeeId);
  }

  @Delete("roles/:id/users/:userId")
  detachUser(@Req() req: Request, @Param("id") id: string, @Param("userId") userId: string) {
    return this.access.detachUser(req.user!.tenantId, req.user!.userId, id, userId);
  }

  @Patch("users/:id")
  updateUser(@Req() req: Request, @Param("id") id: string, @Body() body: { roleIds?: string[]; employeeId?: string | null; isActive?: boolean; displayName?: string }) {
    return this.access.updateUser(req.user!.tenantId, req.user!.userId, id, body);
  }

  @Post("users/:id/reset-password")
  @HttpCode(200)
  resetPassword(@Req() req: Request, @Param("id") id: string) {
    return this.access.resetPassword(req.user!.tenantId, id);
  }
}
