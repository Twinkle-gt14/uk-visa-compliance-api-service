import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { BadRequestException } from "@nestjs/common";
import { AuthGuard, assertSelfOrHrAdmin } from "../auth/auth.guard";
import { AttendanceService } from "./attendance.service";
import type { AttendanceDayDto, AttendanceBatchUpsertDto } from "./attendance.dto";

@Controller("attendance")
@UseGuards(AuthGuard)
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Get(":employeeId")
  getMonth(
    @Req() req: Request,
    @Param("employeeId") employeeId: string,
    @Query("year") yearStr: string,
    @Query("month") monthStr: string
  ) {
    assertSelfOrHrAdmin(req.user!, employeeId);
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10); // 0-indexed, matches frontend convention
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 0 || month > 11) {
      throw new BadRequestException("year and month query params are required (month is 0-indexed, 0-11).");
    }
    return this.attendanceService.getMonth(req.user!.tenantId, employeeId, year, month);
  }

  @Put(":employeeId/:date")
  upsertDay(
    @Req() req: Request,
    @Param("employeeId") employeeId: string,
    @Param("date") date: string,
    @Body() body: AttendanceDayDto
  ) {
    assertSelfOrHrAdmin(req.user!, employeeId);
    return this.attendanceService.upsertDay(req.user!.tenantId, employeeId, { ...body, date });
  }

  @Post(":employeeId/batch")
  upsertBatch(@Req() req: Request, @Param("employeeId") employeeId: string, @Body() body: AttendanceBatchUpsertDto) {
    assertSelfOrHrAdmin(req.user!, employeeId);
    return this.attendanceService.upsertBatch(req.user!.tenantId, employeeId, body.records);
  }
}
