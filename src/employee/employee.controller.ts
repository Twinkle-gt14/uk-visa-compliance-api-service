import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, HrAdminGuard, assertSelfOrHrAdmin } from "../auth/auth.guard";
import { EmployeeService } from "./employee.service";
import type { EmployeeUpsertDto, UpdateStatusDto } from "./employee.dto";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

// AuthGuard applies to everything here (must be signed in at all).
// HrAdminGuard is applied per-method instead of at the class level -
// GET :id is the one exception: an employee-role session legitimately
// needs to read their own record (Leave Apply's details bar, etc.),
// just not anyone else's, so it uses assertSelfOrHrAdmin instead.
// Every other endpoint here (list, create, draft, update, finalize,
// status, onboard) stays HR-only.
@Controller("employees")
@UseGuards(AuthGuard)
export class EmployeeController {
  constructor(private readonly employeeService: EmployeeService) {}

  @Get()
  @UseGuards(HrAdminGuard)
  list(@Req() req: Request, @Query("page") page?: string, @Query("pageSize") pageSize?: string, @Query("onboarded") onboarded?: string) {
    const pageNum = Math.max(1, parseInt(page ?? "1", 10) || 1);
    const sizeNum = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(pageSize ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE));
    const onboardedFilter = onboarded === undefined ? undefined : onboarded === "true";
    return this.employeeService.list(req.user!.tenantId, pageNum, sizeNum, onboardedFilter);
  }

  // These three "change-requests" routes MUST be declared before
  // @Get(":id") / @Patch(":id") below. Nest (Express under the hood)
  // matches routes in declaration order, and ":id" matches any single
  // path segment - including the literal word "change-requests". With
  // ":id" declared first, GET /employees/change-requests was being
  // swallowed by getOne() (id="change-requests"), which then failed
  // trying to look up an employee with that "id" and surfaced as a
  // 500 - this is what broke the Workflow page. Keeping these above
  // the dynamic :id routes is what makes the Workflow page's own
  // endpoint reachable at all.
  /** HR's Workflow page - every employee-submitted change awaiting a
   * decision (or, with ?status=, any other status). */
  @Get("change-requests")
  @UseGuards(HrAdminGuard)
  listChangeRequests(@Req() req: Request, @Query("status") status?: string) {
    return this.employeeService.listChangeRequests(req.user!.tenantId, status);
  }

  @Get("change-requests/:requestId")
  @UseGuards(HrAdminGuard)
  getChangeRequest(@Req() req: Request, @Param("requestId") requestId: string) {
    return this.employeeService.getChangeRequest(req.user!.tenantId, requestId);
  }

  @Patch("change-requests/:requestId/decision")
  @UseGuards(HrAdminGuard)
  decideChangeRequest(
    @Req() req: Request,
    @Param("requestId") requestId: string,
    @Body() body: { decision: "Approved" | "Rejected"; reviewedBy?: string; note?: string }
  ) {
    return this.employeeService.decideChangeRequest(req.user!.tenantId, requestId, body.decision, body.reviewedBy, body.note);
  }

  @Get(":id")
  getOne(@Req() req: Request, @Param("id") id: string) {
    assertSelfOrHrAdmin(req.user!, id);
    return this.employeeService.getById(req.user!.tenantId, id);
  }

  // HR-only (not assertSelfOrHrAdmin) - the History tab is on the
  // Employee Register view page, which is HR-facing; an employee
  // viewing their own record via the self-service redirect doesn't
  // get a History tab at all, so there's no legitimate "self" case
  // to allow here the way getOne() does.
  @Get(":id/history")
  @UseGuards(HrAdminGuard)
  getHistory(@Req() req: Request, @Param("id") id: string) {
    return this.employeeService.listChangeHistory(req.user!.tenantId, id);
  }

  // Same self-or-HR-admin access as GET :id (not HR-only like
  // :id/history) - this drives the Profile tab's per-field "pending
  // approval" display, which an employee needs to see on their own
  // record just as much as HR does on theirs.
  @Get(":id/pending-changes")
  getPendingChanges(@Req() req: Request, @Param("id") id: string) {
    assertSelfOrHrAdmin(req.user!, id);
    return this.employeeService.getPendingFieldChanges(req.user!.tenantId, id);
  }

  @Post()
  @UseGuards(HrAdminGuard)
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
  @UseGuards(HrAdminGuard)
  createDraft(@Req() req: Request, @Body() body: { id?: string; onboardedOnCreate?: boolean }) {
    return this.employeeService.createDraft(req.user!.tenantId, body.id, !!body.onboardedOnCreate);
  }

  /** HR Admin editing anyone -> applies immediately, exactly as
   * before. An employee editing their own record (assertSelfOrHrAdmin
   * allows this the same way GET :id does) -> captured as a pending
   * change request instead; employee_master isn't touched until an HR
   * Admin approves it via PATCH change-requests/:requestId/decision
   * above. changedBy is only meaningful (and only used) on the direct
   * HR-edit path - a submitted request records requestedBy instead. */
  @Patch(":id")
  update(@Req() req: Request, @Param("id") id: string, @Body() body: Partial<EmployeeUpsertDto> & { changedBy?: string }) {
    assertSelfOrHrAdmin(req.user!, id);
    const { changedBy, ...dto } = body;
    if (req.user!.role === "hr_admin") {
      return this.employeeService.update(req.user!.tenantId, id, dto, changedBy);
    }
    return this.employeeService.submitChangeRequest(req.user!.tenantId, id, dto, changedBy);
  }

  /** Promotes a Draft to Active, enforcing the required-field
   * validation that used to run at create() time. Called once, from
   * the wizard's Review & Submit step. */
  @Patch(":id/finalize")
  @UseGuards(HrAdminGuard)
  finalize(@Req() req: Request, @Param("id") id: string, @Body() body: EmployeeUpsertDto) {
    return this.employeeService.finalize(req.user!.tenantId, id, body);
  }

  @Patch(":id/status")
  @UseGuards(HrAdminGuard)
  updateStatus(@Req() req: Request, @Param("id") id: string, @Body() body: UpdateStatusDto) {
    return this.employeeService.updateStatus(req.user!.tenantId, id, body.recordStatus);
  }

  @Patch(":id/onboard")
  @UseGuards(HrAdminGuard)
  onboard(@Req() req: Request, @Param("id") id: string) {
    return this.employeeService.onboardEmployee(req.user!.tenantId, id);
  }
}
