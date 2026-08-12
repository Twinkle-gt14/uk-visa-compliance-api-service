import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors, BadRequestException } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request } from "express";
import { AuthGuard } from "../auth/auth.guard";
import { ComplianceService } from "./compliance.service";
import type { UpdateSkilledWorkerRuleDto, CreateSponsorshipAssessmentDto, RequestUploadDto } from "./compliance.dto";

@Controller("compliance")
@UseGuards(AuthGuard)
export class ComplianceController {
  constructor(private readonly complianceService: ComplianceService) {}

  @Get("skilled-worker-occupations")
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
  getDetail(@Req() req: Request, @Param("socCode") socCode: string) {
    return this.complianceService.getSkilledWorkerDetail(req.user!.tenantId, socCode);
  }

  @Patch("skilled-worker-occupations/:socCode")
  updateRule(@Req() req: Request, @Param("socCode") socCode: string, @Body() body: UpdateSkilledWorkerRuleDto) {
    return this.complianceService.updateSkilledWorkerRule(req.user!.tenantId, socCode, body);
  }

  @Post("import/soc2020-appendix/preview")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 15 * 1024 * 1024 } }))
  previewImport(@Req() req: Request, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException("No file was uploaded.");
    return this.complianceService.previewImport(req.user!.tenantId, file.buffer, file.originalname);
  }

  @Get("import/batches")
  listBatches(@Req() req: Request) {
    return this.complianceService.listImportBatches(req.user!.tenantId);
  }

  @Get("import/batches/:batchId")
  getBatch(@Req() req: Request, @Param("batchId") batchId: string) {
    return this.complianceService.getImportBatch(req.user!.tenantId, batchId);
  }

  @Post("import/batches/:batchId/approve")
  approveBatch(@Req() req: Request, @Param("batchId") batchId: string) {
    return this.complianceService.approveImport(req.user!.tenantId, batchId);
  }

  @Post("import/batches/:batchId/cancel")
  cancelBatch(@Req() req: Request, @Param("batchId") batchId: string) {
    return this.complianceService.cancelImport(req.user!.tenantId, batchId);
  }

  @Get("healthcare-pay-bands")
  listHealthcarePayBands(@Req() req: Request) {
    return this.complianceService.listHealthcarePayBands(req.user!.tenantId);
  }

  @Get("education-pay-scales")
  listEducationPayScales(@Req() req: Request) {
    return this.complianceService.listEducationPayScales(req.user!.tenantId);
  }

  @Get("sponsorship-assessments/:employeeId")
  listSponsorshipAssessments(@Req() req: Request, @Param("employeeId") employeeId: string) {
    return this.complianceService.listSponsorshipAssessments(req.user!.tenantId, employeeId);
  }

  @Post("sponsorship-assessments/:employeeId")
  createSponsorshipAssessment(@Req() req: Request, @Param("employeeId") employeeId: string, @Body() body: CreateSponsorshipAssessmentDto) {
    return this.complianceService.createSponsorshipAssessment(req.user!.tenantId, employeeId, req.user!.userId, body);
  }

  // --- Immigration Salary List (ISL) ---

  @Post("isl/import/preview")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 15 * 1024 * 1024 } }))
  previewIslImport(@Req() req: Request, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException("No file was uploaded.");
    return this.complianceService.previewIslImport(req.user!.tenantId, file.buffer, file.originalname, req.user!.userId);
  }

  @Get("isl/versions") listIslVersions(@Req() req: Request) { return this.complianceService.listIslVersions(req.user!.tenantId); }
  @Get("isl/versions/:versionId") getIslVersion(@Req() req: Request, @Param("versionId") versionId: string) { return this.complianceService.getIslVersion(req.user!.tenantId, versionId); }

  @Post("isl/versions/:versionId/publish")
  publishIslVersion(@Req() req: Request, @Param("versionId") versionId: string, @Body() body: { sourceVersion?: string; sourceUrl?: string }) {
    return this.complianceService.publishIslVersion(req.user!.tenantId, versionId, req.user!.userId, body.sourceVersion, body.sourceUrl);
  }

  @Post("isl/versions/:versionId/reject")
  rejectIslVersion(@Req() req: Request, @Param("versionId") versionId: string) {
    return this.complianceService.rejectIslVersion(req.user!.tenantId, versionId);
  }

  @Get("isl/lookup")
  getIslLookup(@Req() req: Request, @Query("socCode") socCode: string, @Query("jurisdiction") jurisdiction?: string) {
    return this.complianceService.getIslLookup(req.user!.tenantId, socCode, jurisdiction || null);
  }

  // --- Supporting Evidence (Document Upload & Storage) ---

  @Post("documents/:employeeId/request-upload")
  requestDocumentUpload(@Req() req: Request, @Param("employeeId") employeeId: string, @Body() body: RequestUploadDto) {
    return this.complianceService.requestDocumentUpload(req.user!.tenantId, employeeId, req.user!.userId, body);
  }

  @Post("documents/:documentId/confirm")
  confirmDocumentUpload(@Req() req: Request, @Param("documentId") documentId: string) {
    return this.complianceService.confirmDocumentUpload(req.user!.tenantId, documentId);
  }

  @Get("documents/:employeeId")
  listDocuments(@Req() req: Request, @Param("employeeId") employeeId: string) {
    return this.complianceService.listDocuments(req.user!.tenantId, employeeId);
  }

  @Get("documents/:documentId/download-url")
  getDocumentDownloadUrl(@Req() req: Request, @Param("documentId") documentId: string) {
    return this.complianceService.getDocumentDownloadUrl(req.user!.tenantId, documentId);
  }

  @Delete("documents/:documentId")
  deleteDocument(@Req() req: Request, @Param("documentId") documentId: string) {
    return this.complianceService.softDeleteDocument(req.user!.tenantId, documentId);
  }
}
