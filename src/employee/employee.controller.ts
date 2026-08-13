import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../auth/auth.guard";
import { EmployeeService } from "./employee.service";
import type { EmployeeUpsertDto, UpdateStatusDto } from "./employee.dto";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

@Controller("employees")
@UseGuards(AuthGuard)
export class EmployeeController {
  constructor(private readonly employeeService: EmployeeService) {}

  @Get()
  list(@Req() req: Request, @Query("page") page?: string, @Query("pageSize") pageSize?: string, @Query("onboarded") onboarded?: string) {
    const pageNum = Math.max(1, parseInt(page ?? "1", 10) || 1);
    const sizeNum = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(pageSize ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE));
    const onboardedFilter = onboarded === undefined ? undefined : onboarded === "true";
    return this.employeeService.list(req.user!.tenantId, pageNum, sizeNum, onboardedFilter);
  }

  @Get(":id")
  getOne(@Req() req: Request, @Param("id") id: string) {
    return this.employeeService.getById(req.user!.tenantId, id);
  }

  @Post()
  create(@Req() req: Request, @Body() body: EmployeeUpsertDto, @Headers("idempotency-key") idempotencyKey?: string) {
    return this.employeeService.create(req.user!.tenantId, body, idempotencyKey);
  }

  /** Called the moment a wizard opens, before the user has entered
   * anything - gives document-evidence uploads a real id to attach
   * to from step one. `id` is client-generated (see
   * lib/*-store.ts createDraft()); `onboardedOnCreate` is still
   * decided up front since it determines whether an Employee Number
   * gets reserved immediately or only later via onboard(). */
  @Post("draft")
  createDraft(@Req() req: Request, @Body() body: { id?: string; onboardedOnCreate?: boolean }) {
    return this.employeeService.createDraft(req.user!.tenantId, body.id, !!body.onboardedOnCreate);
  }

  @Patch(":id")
  update(@Req() req: Request, @Param("id") id: string, @Body() body: Partial<EmployeeUpsertDto>) {
    return this.employeeService.update(req.user!.tenantId, id, body);
  }

  /** Promotes a Draft to Active, enforcing the required-field
   * validation that used to run at create() time. Called once, from
   * the wizard's Review & Submit step. */
  @Patch(":id/finalize")
  finalize(@Req() req: Request, @Param("id") id: string, @Body() body: EmployeeUpsertDto) {
    return this.employeeService.finalize(req.user!.tenantId, id, body);
  }

  @Patch(":id/status")
  updateStatus(@Req() req: Request, @Param("id") id: string, @Body() body: UpdateStatusDto) {
    return this.employeeService.updateStatus(req.user!.tenantId, id, body.recordStatus);
  }

  @Patch(":id/onboard")
  onboard(@Req() req: Request, @Param("id") id: string) {
    return this.employeeService.onboardEmployee(req.user!.tenantId, id);
  }
}
