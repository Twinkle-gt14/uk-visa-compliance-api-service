import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { EmployeeModule } from "./employee/employee.module";
import { AttendanceModule } from "./attendance/attendance.module";
import { LeaveModule } from "./leave/leave.module";
import { PayslipModule } from "./payslip/payslip.module";
import { SettingsModule } from "./settings/settings.module";
import { ComplianceModule } from "./compliance/compliance.module";
import { ResignationModule } from "./resignation/resignation.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [AuthModule, EmployeeModule, AttendanceModule, LeaveModule, PayslipModule, SettingsModule, ComplianceModule, ResignationModule],
  controllers: [HealthController],
})
export class AppModule {}
