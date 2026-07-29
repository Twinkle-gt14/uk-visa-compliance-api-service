import { BadRequestException, Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../auth/auth.guard";
import { PayslipService } from "./payslip.service";
import type { UpdatePayslipComponentDto } from "./payslip.dto";

@Controller("payslip")
@UseGuards(AuthGuard)
export class PayslipController {
  constructor(private readonly payslipService: PayslipService) {}

  @Get("components")
  listComponents(@Req() req: Request) {
    return this.payslipService.listComponents(req.user!.tenantId);
  }

  @Patch("components/:id")
  updateComponent(@Req() req: Request, @Param("id") id: string, @Body() body: UpdatePayslipComponentDto) {
    return this.payslipService.updateComponent(req.user!.tenantId, id, body.selected);
  }

  @Get(":employeeId")
  compute(
    @Req() req: Request,
    @Param("employeeId") employeeId: string,
    @Query("year") yearStr: string,
    @Query("month") monthStr: string
  ) {
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 0 || month > 11) {
      throw new BadRequestException("year and month query params are required (month is 0-indexed, 0-11).");
    }
    return this.payslipService.computePayslip(req.user!.tenantId, employeeId, year, month);
  }
}
