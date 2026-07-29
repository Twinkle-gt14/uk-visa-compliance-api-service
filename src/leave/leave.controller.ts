import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../auth/auth.guard";
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
    return this.leaveService.listLeaveRequests(req.user!.tenantId, employeeId, status);
  }

  @Post("requests")
  createRequest(@Req() req: Request, @Body() body: CreateLeaveRequestDto) {
    return this.leaveService.createLeaveRequest(req.user!.tenantId, body);
  }

  @Get("summary/:employeeId")
  getSummary(@Req() req: Request, @Param("employeeId") employeeId: string, @Query("referenceDate") referenceDate?: string) {
    const ref = referenceDate ? new Date(referenceDate) : new Date();
    return this.leaveService.getLeaveSummary(req.user!.tenantId, employeeId, ref);
  }

  @Post("requests/:id/decision")
  decideRequest(@Req() req: Request, @Param("id") id: string, @Body() body: DecideLeaveRequestDto) {
    return this.leaveService.decideLeaveRequest(req.user!.tenantId, id, body);
  }

  @Post("requests/:id/cancel")
  cancelRequest(@Req() req: Request, @Param("id") id: string) {
    return this.leaveService.cancelLeaveRequest(req.user!.tenantId, id);
  }
}
