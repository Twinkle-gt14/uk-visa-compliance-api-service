import { Body, Controller, Get, Param, Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors, BadRequestException } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request } from "express";
import { AuthGuard } from "../auth/auth.guard";
import { ComplianceService } from "./compliance.service";
import type { UpdateSkilledWorkerRuleDto, CreateSponsorshipAssessmentDto } from "./compliance.dto";

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
}
