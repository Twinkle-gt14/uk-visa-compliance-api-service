import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors, BadRequestException } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request } from "express";
import { AuthGuard, HrAdminGuard, assertSelfOrHrAdmin } from "../auth/auth.guard";
import { ComplianceService } from "./compliance.service";
import type { UpdateSkilledWorkerRuleDto, CreateSponsorshipAssessmentDto, RequestUploadDto } from "./compliance.dto";

// AuthGuard applies to everything here (must be signed in at all).
// HrAdminGuard is applied per-method rather than at the class level -
// the Supporting Evidence (document) endpoints at the bottom are the
// deliberate exception, since an employee-role session needs to
// upload/list/download/delete their *own* documents (e.g. a Leave
// Apply attachment), just not anyone else's. Everything else in this
// controller (SOC codes, ISL data, sponsorship assessments, imports)
// stays HR-only.
@Controller("compliance")
@UseGuards(AuthGuard)
export class ComplianceController {
  constructor(private readonly complianceService: ComplianceService) {}

  @Get("skilled-worker-occupations")
  @UseGuards(HrAdminGuard)
  list(
    @Req() req: Request,
    @Query("search") search?: string,
    @Query("majorGroup") majorGroup?: string,
    @Query("subMajorGroup") subMajorGroup?: string,
    @Query("minorGroup") minorGroup?: string,
    @Query("status") status?: string,
    @Query("sourceTable") sourceTable?: string,
    @Query("effectiveStatus") effectiveStatus?: "Current" | "Historical" | "Future",
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string
  ) {
    return this.complianceService.listSkilledWorkerOccupations(req.user!.tenantId, {
      search, majorGroup, subMajorGroup, minorGroup, status, sourceTable, effectiveStatus,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get("skilled-worker-occupations/:socCode")
  @UseGuards(HrAdminGuard)
  getDetail(@Req() req: Request, @Param("socCode") socCode: string) {
    return this.complianceService.getSkilledWorkerDetail(req.user!.tenantId, socCode);
  }

  @Patch("skilled-worker-occupations/:socCode")
  @UseGuards(HrAdminGuard)
  updateRule(@Req() req: Request, @Param("socCode") socCode: string, @Body() body: UpdateSkilledWorkerRuleDto) {
    return this.complianceService.updateSkilledWorkerRule(req.user!.tenantId, socCode, body);
  }

  @Post("import/soc2020-appendix/preview")
  @UseGuards(HrAdminGuard)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 15 * 1024 * 1024 } }))
  previewImport(@Req() req: Request, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException("No file was uploaded.");
    return this.complianceService.previewImport(req.user!.tenantId, file.buffer, file.originalname);
  }

  @Get("import/batches")
  @UseGuards(HrAdminGuard)
  listBatches(@Req() req: Request) {
    return this.complianceService.listImportBatches(req.user!.tenantId);
  }

  @Get("import/batches/:batchId")
  @UseGuards(HrAdminGuard)
  getBatch(@Req() req: Request, @Param("batchId") batchId: string) {
    return this.complianceService.getImportBatch(req.user!.tenantId, batchId);
  }

  @Post("import/batches/:batchId/approve")
  @UseGuards(HrAdminGuard)
  approveBatch(@Req() req: Request, @Param("batchId") batchId: string) {
    return this.complianceService.approveImport(req.user!.tenantId, batchId);
  }

  @Post("import/batches/:batchId/cancel")
  @UseGuards(HrAdminGuard)
  cancelBatch(@Req() req: Request, @Param("batchId") batchId: string) {
    return this.complianceService.cancelImport(req.user!.tenantId, batchId);
  }

  @Get("healthcare-pay-bands")
  @UseGuards(HrAdminGuard)
  listHealthcarePayBands(@Req() req: Request) {
    return this.complianceService.listHealthcarePayBands(req.user!.tenantId);
  }

  @Get("education-pay-scales")
  @UseGuards(HrAdminGuard)
  listEducationPayScales(@Req() req: Request) {
    return this.complianceService.listEducationPayScales(req.user!.tenantId);
  }

  @Get("sponsorship-assessments/:employeeId")
  @UseGuards(HrAdminGuard)
  listSponsorshipAssessments(@Req() req: Request, @Param("employeeId") employeeId: string) {
    return this.complianceService.listSponsorshipAssessments(req.user!.tenantId, employeeId);
  }

  @Post("sponsorship-assessments/:employeeId")
  @UseGuards(HrAdminGuard)
  createSponsorshipAssessment(@Req() req: Request, @Param("employeeId") employeeId: string, @Body() body: CreateSponsorshipAssessmentDto) {
    return this.complianceService.createSponsorshipAssessment(req.user!.tenantId, employeeId, req.user!.userId, body);
  }

  // --- Immigration Salary List (ISL) ---

  @Post("isl/import/preview")
  @UseGuards(HrAdminGuard)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 15 * 1024 * 1024 } }))
  previewIslImport(@Req() req: Request, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException("No file was uploaded.");
    return this.complianceService.previewIslImport(req.user!.tenantId, file.buffer, file.originalname, req.user!.userId);
  }

  @Get("isl/versions") @UseGuards(HrAdminGuard) listIslVersions(@Req() req: Request) { return this.complianceService.listIslVersions(req.user!.tenantId); }
  @Get("isl/versions/:versionId") @UseGuards(HrAdminGuard) getIslVersion(@Req() req: Request, @Param("versionId") versionId: string) { return this.complianceService.getIslVersion(req.user!.tenantId, versionId); }

  @Post("isl/versions/:versionId/publish")
  @UseGuards(HrAdminGuard)
  publishIslVersion(@Req() req: Request, @Param("versionId") versionId: string, @Body() body: { sourceVersion?: string; sourceUrl?: string }) {
    return this.complianceService.publishIslVersion(req.user!.tenantId, versionId, req.user!.userId, body.sourceVersion, body.sourceUrl);
  }

  @Post("isl/versions/:versionId/reject")
  @UseGuards(HrAdminGuard)
  rejectIslVersion(@Req() req: Request, @Param("versionId") versionId: string) {
    return this.complianceService.rejectIslVersion(req.user!.tenantId, versionId);
  }

  @Get("isl/lookup")
  @UseGuards(HrAdminGuard)
  getIslLookup(@Req() req: Request, @Query("socCode") socCode: string, @Query("jurisdiction") jurisdiction?: string) {
    return this.complianceService.getIslLookup(req.user!.tenantId, socCode, jurisdiction || null);
  }

  // --- Supporting Evidence (Document Upload & Storage) - self-only for
  // an employee session, not HR-only like the rest of this controller. ---

  @Post("documents/:employeeId/request-upload")
  requestDocumentUpload(@Req() req: Request, @Param("employeeId") employeeId: string, @Body() body: RequestUploadDto) {
    assertSelfOrHrAdmin(req.user!, employeeId);
    return this.complianceService.requestDocumentUpload(req.user!.tenantId, employeeId, req.user!.userId, body);
  }

  // --- Role-scoped documents (Settings > Role advertisement evidence)
  // - HR-admin only, since Roles are settings-level master data, not
  // something an employee session has any business touching. Shares
  // the generic confirm/download-url/delete endpoints below with
  // employee documents, since those only need a document id. ---

  @Post("role-documents/:roleId/request-upload")
  @UseGuards(HrAdminGuard)
  requestRoleDocumentUpload(@Req() req: Request, @Param("roleId") roleId: string, @Body() body: RequestUploadDto) {
    return this.complianceService.requestRoleDocumentUpload(req.user!.tenantId, roleId, req.user!.userId, body);
  }

  @Get("role-documents/:roleId")
  @UseGuards(HrAdminGuard)
  listRoleDocuments(@Req() req: Request, @Param("roleId") roleId: string) {
    return this.complianceService.listRoleDocuments(req.user!.tenantId, roleId);
  }

  @Post("documents/:documentId/confirm")
  confirmDocumentUpload(@Req() req: Request, @Param("documentId") documentId: string) {
    const requesterEmployeeId = req.user!.role === "hr_admin" ? undefined : req.user!.employeeId!;
    return this.complianceService.confirmDocumentUpload(req.user!.tenantId, documentId, requesterEmployeeId);
  }

  @Get("documents/:employeeId")
  listDocuments(@Req() req: Request, @Param("employeeId") employeeId: string) {
    assertSelfOrHrAdmin(req.user!, employeeId);
    return this.complianceService.listDocuments(req.user!.tenantId, employeeId);
  }

  @Get("documents/:documentId/download-url")
  getDocumentDownloadUrl(@Req() req: Request, @Param("documentId") documentId: string) {
    const requesterEmployeeId = req.user!.role === "hr_admin" ? undefined : req.user!.employeeId!;
    return this.complianceService.getDocumentDownloadUrl(req.user!.tenantId, documentId, requesterEmployeeId);
  }

  @Delete("documents/:documentId")
  deleteDocument(@Req() req: Request, @Param("documentId") documentId: string) {
    const requesterEmployeeId = req.user!.role === "hr_admin" ? undefined : req.user!.employeeId!;
    return this.complianceService.softDeleteDocument(req.user!.tenantId, documentId, requesterEmployeeId);
  }
}
