import { Body, Controller, Delete, Get, Put, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, HrAdminGuard } from "../auth/auth.guard";
import { DashboardService } from "./dashboard.service";

@Controller("dashboard")
@UseGuards(AuthGuard, HrAdminGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get("layout")
  getLayout(@Req() req: Request) {
    return this.dashboardService.getLayout(req.user!.tenantId, req.user!.userId);
  }

  @Put("layout")
  saveLayout(@Req() req: Request, @Body() body: { layout: unknown }) {
    return this.dashboardService.saveLayout(req.user!.tenantId, req.user!.userId, body?.layout, req.user!.email);
  }

  @Delete("layout")
  resetLayout(@Req() req: Request) {
    return this.dashboardService.resetLayout(req.user!.tenantId, req.user!.userId);
  }

  @Get("summary")
  getSummary(@Req() req: Request) {
    return this.dashboardService.getSummary(req.user!.tenantId);
  }
}
