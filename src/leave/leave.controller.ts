import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, assertSelfOrHrAdmin } from "../auth/auth.guard";
import { LeaveService } from "./leave.service";
import type { CreateLeaveRequestDto, DecideLeaveRequestDto, UpdateLeaveTypeDto } from "./leave.dto";

@Controller("leave")
@UseGuards(AuthGuard)
export class LeaveController {
  constructor(private readonly leaveService: LeaveService) {}

  @Get("types")
  listTypes(@Req() req: Request) {
    return this.leaveService.listLeaveTypes(req.user!.tenantId);
  }

  @Patch("types/:id")
  updateType(@Req() req: Request, @Param("id") id: string, @Body() body: UpdateLeaveTypeDto) {
    return this.leaveService.updateLeaveType(req.user!.tenantId, id, body);
  }

  @Get("requests")
  listRequests(@Req() req: Request, @Query("employeeId") employeeId?: string, @Query("status") status?: string) {
    // An employee session with no employeeId filter would otherwise see
    // every request tenant-wide (listLeaveRequests treats a missing
    // filter as "all") - force it to their own id rather than trusting
    // the query param either way.
    const scopedEmployeeId = req.user!.role === "hr_admin" ? employeeId : req.user!.employeeId!;
    if (req.user!.role !== "hr_admin" && employeeId && employeeId !== req.user!.employeeId) {
      throw new ForbiddenException("You can only view your own leave requests.");
    }
    return this.leaveService.listLeaveRequests(req.user!.tenantId, scopedEmployeeId, status);
  }

  @Post("requests")
  createRequest(@Req() req: Request, @Body() body: CreateLeaveRequestDto) {
    assertSelfOrHrAdmin(req.user!, body.employeeId);
    return this.leaveService.createLeaveRequest(req.user!.tenantId, body);
  }

  @Get("summary/:employeeId")
  getSummary(@Req() req: Request, @Param("employeeId") employeeId: string, @Query("referenceDate") referenceDate?: string) {
    assertSelfOrHrAdmin(req.user!, employeeId);
    const ref = referenceDate ? new Date(referenceDate) : new Date();
    return this.leaveService.getLeaveSummary(req.user!.tenantId, employeeId, ref);
  }

  /** Approve/reject is HR-only, full stop - an employee session never
   * has a legitimate reason to hit this, on their own request or
   * anyone else's, so this doesn't use assertSelfOrHrAdmin at all. */
  @Post("requests/:id/decision")
  decideRequest(@Req() req: Request, @Param("id") id: string, @Body() body: DecideLeaveRequestDto) {
    if (req.user!.role !== "hr_admin") {
      throw new ForbiddenException("Only HR can approve or reject leave requests.");
    }
    return this.leaveService.decideLeaveRequest(req.user!.tenantId, id, body);
  }

  @Post("requests/:id/cancel")
  cancelRequest(@Req() req: Request, @Param("id") id: string) {
    const requesterEmployeeId = req.user!.role === "hr_admin" ? undefined : req.user!.employeeId!;
    return this.leaveService.cancelLeaveRequest(req.user!.tenantId, id, requesterEmployeeId);
  }
}
