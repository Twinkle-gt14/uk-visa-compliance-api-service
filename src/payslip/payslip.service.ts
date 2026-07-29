import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { withTenant } from "../db";
import type { PayslipComponentDto, PayslipComputationDto } from "./payslip.dto";

/** Seeded once per tenant on first read, from the exact same
 * PAYSLIP_EARNINGS/PAYSLIP_DEDUCTIONS lists in lib/settings-data.ts -
 * same slugs (as `id`), same names/descriptions, same default
 * enabled/disabled state. Only Overtime, Bonus (earnings) and Pension
 * Contribution (Employee), Union Dues (deductions) are actually wired
 * into the calculation below - the rest exist as configurable toggles
 * but aren't computed yet, matching the frontend's existing behaviour
 * exactly rather than inventing new calculation rules for them. */
const DEFAULT_EARNINGS = [
  { slug: "earn-basic", name: "Basic Pay", description: "Standard contracted salary or hourly wage.", selected: true },
  { slug: "earn-overtime", name: "Overtime", description: "Additional pay for hours worked beyond contracted hours.", selected: true },
  { slug: "earn-bonus", name: "Bonus", description: "Discretionary or contractual bonus payments.", selected: false },
  { slug: "earn-commission", name: "Commission", description: "Performance or sales-related commission.", selected: false },
  { slug: "earn-holiday-pay", name: "Holiday Pay", description: "Pay for statutory or contractual annual leave.", selected: true },
  { slug: "earn-ssp", name: "Statutory Sick Pay (SSP)", description: "Statutory minimum pay during qualifying sickness absence.", selected: true },
  { slug: "earn-smp", name: "Statutory Maternity Pay (SMP)", description: "Statutory pay during maternity leave.", selected: true },
  { slug: "earn-spp", name: "Statutory Paternity Pay (SPP)", description: "Statutory pay during paternity leave.", selected: true },
  { slug: "earn-shpp", name: "Statutory Shared Parental Pay (ShPP)", description: "Statutory pay during shared parental leave.", selected: false },
  { slug: "earn-expenses", name: "Expenses Reimbursement", description: "Reimbursement of pre-approved business expenses.", selected: false },
  { slug: "earn-pension-er", name: "Pension Contribution (Employer)", description: "Employer's contribution to the workplace pension.", selected: true },
];

const DEFAULT_DEDUCTIONS = [
  { slug: "ded-paye", name: "Income Tax (PAYE)", description: "Tax deducted under Pay As You Earn.", selected: true },
  { slug: "ded-ni", name: "National Insurance (Employee)", description: "Employee National Insurance contributions.", selected: true },
  { slug: "ded-pension-ee", name: "Pension Contribution (Employee)", description: "Employee's contribution to the workplace pension.", selected: true },
  { slug: "ded-student-loan", name: "Student Loan Repayment", description: "Deductions under the relevant student loan plan.", selected: false },
  { slug: "ded-postgrad-loan", name: "Postgraduate Loan Repayment", description: "Deductions for postgraduate loan repayment.", selected: false },
  { slug: "ded-aeo", name: "Attachment of Earnings Order", description: "Court-ordered deduction from earnings.", selected: false },
  { slug: "ded-union", name: "Union Dues", description: "Trade union membership subscription.", selected: false },
  { slug: "ded-salary-sacrifice", name: "Salary Sacrifice", description: "Deductions under a salary sacrifice scheme (e.g. cycle to work, additional pension).", selected: false },
  { slug: "ded-season-ticket", name: "Season Ticket Loan Repayment", description: "Repayment instalments for a season ticket loan.", selected: false },
];

// Same simplified UK PAYE/NI approximations as lib/payslip-data.ts -
// not a real tax engine, kept byte-identical to the frontend's numbers.
const MONTHLY_PERSONAL_ALLOWANCE = 1047.5;
const MONTHLY_NI_THRESHOLD = 1048;
const MONTHLY_EMPLOYER_NI_THRESHOLD = 758.33;
const BASIC_RATE = 0.2;
const EMPLOYEE_NI_RATE = 0.08;
const EMPLOYER_NI_RATE = 0.138;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Port of countElapsedPayPeriods() in lib/payslip-data.ts, simplified
 * to take a real Date directly (the frontend's version parses a
 * display label like "31-May-2026"; this endpoint already gets a
 * clean year/month, so that parsing step isn't needed here). */
function countElapsedPayPeriods(periodEnd: Date): number {
  const taxYearStartYear = periodEnd.getUTCMonth() < 3 ? periodEnd.getUTCFullYear() - 1 : periodEnd.getUTCFullYear();
  const taxYearStart = new Date(Date.UTC(taxYearStartYear, 3, 6));
  if (periodEnd < taxYearStart) return 1;
  const monthsElapsed =
    (periodEnd.getUTCFullYear() - taxYearStart.getUTCFullYear()) * 12 + (periodEnd.getUTCMonth() - taxYearStart.getUTCMonth());
  return Math.max(1, monthsElapsed + 1);
}

function rowToComponent(r: any): PayslipComponentDto {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    componentType: r.component_type,
    selected: r.is_selected,
    order: r.sort_order,
  };
}

@Injectable()
export class PayslipService {
  /** Returns the tenant's payslip components, seeding the standard
   * defaults on first use - same seed-on-first-read pattern as
   * reference.leave_type. Replaces the old in-memory-only
   * PayslipComponentSettingsProvider (React Context, lost every
   * session) with a real, tenant-shared, persisted list. */
  async listComponents(tenantId: string): Promise<PayslipComponentDto[]> {
    return withTenant(tenantId, async (client) => {
      const existing = await client.query("SELECT * FROM reference.payslip_component ORDER BY component_type, sort_order");
      if (existing.rowCount) {
        return existing.rows.map(rowToComponent);
      }
      let order = 0;
      for (const e of DEFAULT_EARNINGS) {
        await client.query(
          `INSERT INTO reference.payslip_component (tenant_id, slug, name, description, component_type, is_selected, sort_order)
           VALUES ($1,$2,$3,$4,'earning',$5,$6)`,
          [tenantId, e.slug, e.name, e.description, e.selected, order++]
        );
      }
      order = 0;
      for (const d of DEFAULT_DEDUCTIONS) {
        await client.query(
          `INSERT INTO reference.payslip_component (tenant_id, slug, name, description, component_type, is_selected, sort_order)
           VALUES ($1,$2,$3,$4,'deduction',$5,$6)`,
          [tenantId, d.slug, d.name, d.description, d.selected, order++]
        );
      }
      const seeded = await client.query("SELECT * FROM reference.payslip_component ORDER BY component_type, sort_order");
      return seeded.rows.map(rowToComponent);
    });
  }

  async updateComponent(tenantId: string, id: string, selected: boolean): Promise<PayslipComponentDto> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        "UPDATE reference.payslip_component SET is_selected = $1, updated_at = now() WHERE id = $2 RETURNING *",
        [selected, id]
      );
      if (!result.rowCount) throw new NotFoundException("Payslip component not found.");
      return rowToComponent(result.rows[0]);
    });
  }

  /** Computes a payslip from the employee's real hourly_rate and real
   * hours actually worked that calendar month (summed from
   * attendance.attendance_record where status is 'present' or
   * 'remote' and both check_in/check_out are recorded) - not a
   * hardcoded mock number. `year`/`month` (0-indexed) identify the pay
   * period; period end is treated as the last calendar day of that
   * month, matching the frontend's existing monthly period model. */
  async computePayslip(tenantId: string, employeeId: string, year: number, month: number): Promise<PayslipComputationDto> {
    await this.listComponents(tenantId); // ensure seeded before reading below

    return withTenant(tenantId, async (client) => {
      const empRes = await client.query(
        `SELECT m.first_name, m.middle_name, m.last_name, m.employee_reference_no, m.hourly_rate, d.name AS department_name
         FROM employee.employee_master m
         JOIN reference.department d ON d.id = m.department_id
         WHERE m.id = $1 AND NOT m.is_deleted`,
        [employeeId]
      );
      if (!empRes.rowCount) throw new NotFoundException("Employee not found.");
      const emp = empRes.rows[0];
      const hourlyRate = emp.hourly_rate !== null ? Number(emp.hourly_rate) : null;
      if (hourlyRate === null) {
        throw new BadRequestException("This employee has no hourly rate set - add one before generating a payslip.");
      }

      const periodStart = `${year}-${String(month + 1).padStart(2, "0")}-01`;
      const periodEnd = new Date(year, month + 1, 0).toISOString().slice(0, 10);

      const hoursRes = await client.query(
        `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (check_out - check_in)) / 3600.0), 0) AS total_hours
         FROM attendance.attendance_record
         WHERE employee_id = $1 AND record_date BETWEEN $2 AND $3
           AND status IN ('present', 'remote') AND check_in IS NOT NULL AND check_out IS NOT NULL`,
        [employeeId, periodStart, periodEnd]
      );
      const hoursWorkedThisPeriod = round2(Number(hoursRes.rows[0].total_hours));

      const componentsRes = await client.query(
        "SELECT slug, component_type, is_selected FROM reference.payslip_component WHERE tenant_id = $1",
        [tenantId]
      );
      const isSelected = (slug: string) => componentsRes.rows.some((r) => r.slug === slug && r.is_selected);

      const basicPay = round2(hoursWorkedThisPeriod * hourlyRate);
      const earningLines: { label: string; amount: number }[] = [{ label: "Basic Pay", amount: basicPay }];
      if (isSelected("earn-overtime")) earningLines.push({ label: "Overtime", amount: 86.4 });
      if (isSelected("earn-bonus")) earningLines.push({ label: "Bonus", amount: 150 });
      const totalPayments = round2(earningLines.reduce((s, l) => s + l.amount, 0));

      const incomeTax = round2(Math.max(0, basicPay - MONTHLY_PERSONAL_ALLOWANCE) * BASIC_RATE);
      const employeeNic = round2(Math.max(0, basicPay - MONTHLY_NI_THRESHOLD) * EMPLOYEE_NI_RATE);
      const employerNic = round2(Math.max(0, basicPay - MONTHLY_EMPLOYER_NI_THRESHOLD) * EMPLOYER_NI_RATE);

      const deductionLines: { label: string; amount: number }[] = [
        { label: "Income Tax", amount: incomeTax },
        { label: "National Insurance", amount: employeeNic },
      ];
      if (isSelected("ded-pension-ee")) deductionLines.push({ label: "Pension Contribution", amount: round2(basicPay * 0.05) });
      if (isSelected("ded-union")) deductionLines.push({ label: "Union Dues", amount: 12 });
      const totalDeductions = round2(deductionLines.reduce((s, l) => s + l.amount, 0));

      const netPay = round2(totalPayments - totalDeductions);
      const periodsElapsed = countElapsedPayPeriods(new Date(periodEnd));

      return {
        employeeId,
        employeeName: [emp.first_name, emp.middle_name, emp.last_name].filter(Boolean).join(" "),
        employeeNo: emp.employee_reference_no,
        department: emp.department_name,
        payPeriodEnd: periodEnd,
        hourlyRate,
        hoursWorkedThisPeriod,
        earningLines,
        deductionLines,
        totalPayments,
        totalDeductions,
        netPay,
        ytdTaxableGrossPay: round2(basicPay * periodsElapsed),
        ytdIncomeTax: round2(incomeTax * periodsElapsed),
        ytdEmployeeNic: round2(employeeNic * periodsElapsed),
        ytdEmployerNic: round2(employerNic * periodsElapsed),
      };
    });
  }
}
