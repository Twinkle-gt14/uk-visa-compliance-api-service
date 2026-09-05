import { Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, assertSelfOrHrAdmin } from "../auth/auth.guard";
import { ResignationService } from "./resignation.service";
import type { CreateResignationRequestDto, DecideResignationRequestDto } from "./resignation.dto";

@Controller("resignation")
@UseGuards(AuthGuard)
export class ResignationController {
  constructor(private readonly resignationService: ResignationService) {}

  /** Readable by any authenticated user (not HR-only) - an employee
   * has to see this to know their own tentative last date before
   * submitting. See ResignationService.getCurrentNoticePeriod's own
   * comment on why this doesn't go through SettingsController. */
  @Get("notice-period")
  getCurrentNoticePeriod(@Req() req: Request) {
    return this.resignationService.getCurrentNoticePeriod(req.user!.tenantId);
  }

  @Get("requests")
  listRequests(@Req() req: Request, @Query("employeeId") employeeId?: string, @Query("status") status?: string) {
    // Same scoping rule as GET /leave/requests: an employee session
    // always gets forced to their own id, regardless of what's asked
    // for, rather than trusting the query param.
    const scopedEmployeeId = req.user!.role === "hr_admin" ? employeeId : req.user!.employeeId!;
    if (req.user!.role !== "hr_admin" && employeeId && employeeId !== req.user!.employeeId) {
      throw new ForbiddenException("You can only view your own resignation requests.");
    }
    return this.resignationService.listResignationRequests(req.user!.tenantId, scopedEmployeeId, status);
  }

  @Post("requests")
  createRequest(@Req() req: Request, @Body() body: CreateResignationRequestDto) {
    assertSelfOrHrAdmin(req.user!, body.employeeId);
    return this.resignationService.createResignationRequest(req.user!.tenantId, body);
  }

  /** HR-only, same reasoning as leave's own decision endpoint - an
   * employee session never has a legitimate reason to approve or
   * reject a resignation, including their own. */
  @Post("requests/:id/decision")
  decideRequest(@Req() req: Request, @Param("id") id: string, @Body() body: DecideResignationRequestDto) {
    if (req.user!.role !== "hr_admin") {
      throw new ForbiddenException("Only HR can approve or reject resignation requests.");
    }
    return this.resignationService.decideResignationRequest(req.user!.tenantId, id, body);
  }
}
