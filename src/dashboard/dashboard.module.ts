import { Module } from "@nestjs/common";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { EmployeeModule } from "../employee/employee.module";

@Module({
  imports: [EmployeeModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
