import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UploadedFile, UseGuards, UseInterceptors, BadRequestException } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request } from "express";
import { AuthGuard, HrAdminGuard } from "../auth/auth.guard";
import { SettingsService } from "./settings.service";
import type { CreateHolidayDto, EmployerProfileDto, SponsorshipProfileDto, UpdateHolidayDto, PositionDto } from "./settings.dto";

@Controller("settings")
@UseGuards(AuthGuard, HrAdminGuard)
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  // --- Department ---
  @Get("departments") listDepartments(@Req() req: Request) { return this.settingsService.listSimple(req.user!.tenantId, "department"); }
  @Post("departments") createDepartment(@Req() req: Request, @Body() body: { name: string }) { return this.settingsService.createSimple(req.user!.tenantId, "department", body.name); }
  @Patch("departments/:id") updateDepartment(@Req() req: Request, @Param("id") id: string, @Body() body: { name: string }) { return this.settingsService.updateSimple(req.user!.tenantId, "department", id, body.name); }
  @Delete("departments/:id") deleteDepartment(@Req() req: Request, @Param("id") id: string) { return this.settingsService.deleteSimple(req.user!.tenantId, "department", id); }

  // --- Position ---
  @Get("positions") listPositions(@Req() req: Request) { return this.settingsService.listPositions(req.user!.tenantId); }
  @Post("positions") createPosition(@Req() req: Request, @Body() body: Partial<PositionDto> & { name: string }) { return this.settingsService.createPosition(req.user!.tenantId, body); }
  @Patch("positions/:id") updatePosition(@Req() req: Request, @Param("id") id: string, @Body() body: Partial<PositionDto> & { name: string }) { return this.settingsService.updatePosition(req.user!.tenantId, id, body); }
  @Delete("positions/:id") deletePosition(@Req() req: Request, @Param("id") id: string) { return this.settingsService.deleteSimple(req.user!.tenantId, "position", id); }

  // --- Visa Type ---
  @Get("visa-types") listVisaTypes(@Req() req: Request) { return this.settingsService.listSimple(req.user!.tenantId, "visa_type"); }
  @Post("visa-types") createVisaType(@Req() req: Request, @Body() body: { name: string }) { return this.settingsService.createSimple(req.user!.tenantId, "visa_type", body.name); }
  @Patch("visa-types/:id") updateVisaType(@Req() req: Request, @Param("id") id: string, @Body() body: { name: string }) { return this.settingsService.updateSimple(req.user!.tenantId, "visa_type", id, body.name); }
  @Delete("visa-types/:id") deleteVisaType(@Req() req: Request, @Param("id") id: string) { return this.settingsService.deleteSimple(req.user!.tenantId, "visa_type", id); }

  // --- Work Location ---
  @Get("work-locations") listWorkLocations(@Req() req: Request) { return this.settingsService.listWorkLocations(req.user!.tenantId); }
  @Post("work-locations") createWorkLocation(@Req() req: Request, @Body() body: { name: string; jurisdictionId?: string }) { return this.settingsService.createWorkLocation(req.user!.tenantId, body.name, body.jurisdictionId); }
  @Patch("work-locations/:id") updateWorkLocation(@Req() req: Request, @Param("id") id: string, @Body() body: { name: string; jurisdictionId?: string }) { return this.settingsService.updateWorkLocation(req.user!.tenantId, id, body.name, body.jurisdictionId); }
  @Delete("work-locations/:id") deleteWorkLocation(@Req() req: Request, @Param("id") id: string) { return this.settingsService.deleteSimple(req.user!.tenantId, "work_location", id); }

  @Get("jurisdictions") listJurisdictions(@Req() req: Request) { return this.settingsService.listJurisdictions(req.user!.tenantId); }

  // --- Holidays ---
  @Get("holidays") listHolidays(@Req() req: Request) { return this.settingsService.listHolidays(req.user!.tenantId); }
  @Post("holidays") createHoliday(@Req() req: Request, @Body() body: CreateHolidayDto) { return this.settingsService.createHoliday(req.user!.tenantId, body.date, body.name); }
  @Patch("holidays/:id") updateHoliday(@Req() req: Request, @Param("id") id: string, @Body() body: UpdateHolidayDto) { return this.settingsService.updateHoliday(req.user!.tenantId, id, body.date, body.name); }
  @Delete("holidays/:id") deleteHoliday(@Req() req: Request, @Param("id") id: string) { return this.settingsService.deleteHoliday(req.user!.tenantId, id); }

  // --- Employer profile (singleton) ---
  @Get("employer") getEmployer(@Req() req: Request) { return this.settingsService.getEmployerProfile(req.user!.tenantId); }
  @Patch("employer") updateEmployer(@Req() req: Request, @Body() body: Partial<EmployerProfileDto>) { return this.settingsService.updateEmployerProfile(req.user!.tenantId, body); }

  // --- Sponsorship profile (singleton) ---
  @Get("sponsorship") getSponsorship(@Req() req: Request) { return this.settingsService.getSponsorshipProfile(req.user!.tenantId); }
  @Patch("sponsorship") updateSponsorship(@Req() req: Request, @Body() body: Partial<SponsorshipProfileDto>) { return this.settingsService.updateSponsorshipProfile(req.user!.tenantId, body); }

  // --- SOC2020 Framework ---
  @Get("soc2020") listSoc2020(@Req() req: Request) { return this.settingsService.listSoc2020(req.user!.tenantId); }

  @Post("soc2020/upload")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  uploadSoc2020(@Req() req: Request, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException("No file was uploaded.");
    return this.settingsService.uploadSoc2020(req.user!.tenantId, file.buffer);
  }
}
