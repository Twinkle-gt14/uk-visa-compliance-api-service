import { BadRequestException, Injectable } from "@nestjs/common";
import { withTenant } from "../db";
import { EmployeeService } from "../employee/employee.service";

export interface DashboardLayoutItem {
  id: string;
  size: number;
  height?: number;
  visible: boolean;
}

const isValidHeight = (n: unknown) => n === undefined || n === null || (Number.isInteger(n) && (n as number) >= 80 && (n as number) <= 1500);
const isValidSize = (n: unknown) => Number.isInteger(n) && (n as number) >= 10 && (n as number) <= 60;

function toDateStr(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

@Injectable()
export class DashboardService {
  constructor(private readonly employeeService: EmployeeService) {}

  async getLayout(tenantId: string, userId: string): Promise<{ layout: DashboardLayoutItem[] | null }> {
    return withTenant(tenantId, async (client) => {
      const r = await client.query("SELECT layout FROM reference.dashboard_layout WHERE tenant_id = $1 AND user_id = $2", [tenantId, userId]);
      return { layout: r.rows[0]?.layout ?? null };
    });
  }

  async saveLayout(tenantId: string, userId: string, layout: unknown, updatedBy: string): Promise<{ layout: DashboardLayoutItem[] }> {
    if (!Array.isArray(layout) || layout.length > 100) throw new BadRequestException("Invalid layout.");
    const clean: DashboardLayoutItem[] = [];
    for (const item of layout) {
      if (!item || typeof item.id !== "string" || !item.id || !isValidSize(item.size) || !isValidHeight(item.height) || typeof item.visible !== "boolean") {
        throw new BadRequestException("Invalid layout item.");
      }
      clean.push({ id: item.id, size: item.size, ...(item.height ? { height: item.height } : {}), visible: item.visible });
    }
    return withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO reference.dashboard_layout (tenant_id, user_id, layout, updated_by)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET layout = EXCLUDED.layout, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [tenantId, userId, JSON.stringify(clean), updatedBy || null]
      );
      return { layout: clean };
    });
  }

  async resetLayout(tenantId: string, userId: string): Promise<{ layout: null }> {
    await withTenant(tenantId, (client) => client.query("DELETE FROM reference.dashboard_layout WHERE tenant_id = $1 AND user_id = $2", [tenantId, userId]));
    return { layout: null };
  }

  /** Live numbers for the dashboard widgets that aren't derivable from
   * the employee/leave lists the page already fetches. */
  async getSummary(tenantId: string) {
    const ukvi = await this.employeeService.listUkviActions(tenantId);

    return withTenant(tenantId, async (client) => {
      const today = new Date().toISOString().slice(0, 10);

      // Expiry buckets - Overdue / <30 / <60 / <90 days, on Active onboarded employees.
      const bucket = async (sql: string) => {
        const r = await client.query(
          `SELECT
             COUNT(*) FILTER (WHERE x.d < CURRENT_DATE) AS overdue,
             COUNT(*) FILTER (WHERE x.d >= CURRENT_DATE AND x.d < CURRENT_DATE + 30) AS d30,
             COUNT(*) FILTER (WHERE x.d >= CURRENT_DATE + 30 AND x.d < CURRENT_DATE + 60) AS d60,
             COUNT(*) FILTER (WHERE x.d >= CURRENT_DATE + 60 AND x.d < CURRENT_DATE + 90) AS d90
           FROM (${sql}) x`
        );
        const row = r.rows[0];
        return { overdue: Number(row.overdue), d30: Number(row.d30), d60: Number(row.d60), d90: Number(row.d90) };
      };
      const active = "m.record_status = 'Active' AND m.is_onboarded AND NOT m.is_deleted";
      const [visa, cos, passport, rtw] = await Promise.all([
        bucket(`SELECT v.expiry_date AS d FROM employee.employee_visa_detail v JOIN employee.employee_master m ON m.id = v.employee_id WHERE ${active} AND m.sponsored_employee AND v.expiry_date IS NOT NULL`),
        bucket(`SELECT c.expiry_date AS d FROM employee.employee_cos_detail c JOIN employee.employee_master m ON m.id = c.employee_id WHERE ${active} AND m.sponsored_employee AND c.expiry_date IS NOT NULL`),
        bucket(`SELECT p.expiry_date AS d FROM employee.employee_passport_detail p JOIN employee.employee_master m ON m.id = p.employee_id WHERE ${active} AND p.expiry_date IS NOT NULL`),
        bucket(`SELECT r.expiry_date AS d FROM employee.employee_rtw_check r JOIN employee.employee_master m ON m.id = r.employee_id WHERE ${active} AND r.expiry_date IS NOT NULL`),
      ]);

      // ---- Attendance (all from attendance.attendance_record + approved leave) ----
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      const holidays = new Set((await client.query("SELECT holiday_date FROM reference.holiday")).rows.map((r) => toDateStr(r.holiday_date)));
      const isWorkingDay = (d: Date) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !holidays.has(iso(d));
      // The day the "today" figures describe: today, or the latest working day before it.
      const refDay = new Date(today + "T00:00:00Z");
      while (!isWorkingDay(refDay)) refDay.setUTCDate(refDay.getUTCDate() - 1);
      const refDate = iso(refDay);

      const staff = await client.query(
        `SELECT m.id, m.first_name, m.middle_name, m.last_name, m.date_of_joining
         FROM employee.employee_master m WHERE ${active}`
      );
      const attRows = await client.query(
        `SELECT employee_id, record_date, status FROM attendance.attendance_record WHERE record_date >= CURRENT_DATE - 120`
      );
      const statusByEmp = new Map<string, Map<string, string>>();
      for (const r of attRows.rows) {
        if (!statusByEmp.has(r.employee_id)) statusByEmp.set(r.employee_id, new Map());
        statusByEmp.get(r.employee_id)!.set(toDateStr(r.record_date), r.status);
      }
      const leaveToday = await client.query(
        `SELECT DISTINCT employee_id FROM leave.leave_request WHERE status = 'approved' AND start_date <= $1 AND end_date >= $1`,
        [refDate]
      );
      const onLeaveIds = new Set<string>(leaveToday.rows.map((r) => r.employee_id));

      let presentToday = 0;
      let absentToday = 0;
      const absences: { employeeId: string; employeeName: string; daysAbsent: number; risk: "Monitor" | "Warning" | "Critical" }[] = [];
      for (const e of staff.rows) {
        const st = statusByEmp.get(e.id) ?? new Map<string, string>();
        const todayStatus = st.get(refDate);
        if (todayStatus === "present" || todayStatus === "remote") presentToday += 1;
        if (todayStatus === "absent") absentToday += 1;
        if (todayStatus === "leave" || todayStatus === "sick-leave") onLeaveIds.add(e.id);

        // current unauthorised-absence run: consecutive working days back from refDate with no
        // present/remote/leave entry (a missing entry or an 'absent' one both count)
        const joining = e.date_of_joining ? toDateStr(e.date_of_joining) : null;
        if (!joining || joining > refDate) continue;
        let run = 0;
        for (let d = new Date(refDate + "T00:00:00Z"); iso(d) >= joining; d.setUTCDate(d.getUTCDate() - 1)) {
          if (!isWorkingDay(d)) continue;
          const v = st.get(iso(d));
          if (v === "present" || v === "remote" || v === "leave" || v === "sick-leave") break;
          run += 1;
        }
        if (run >= 1 && !onLeaveIds.has(e.id)) {
          absences.push({
            employeeId: e.id,
            employeeName: [e.first_name, e.middle_name, e.last_name].filter(Boolean).join(" "),
            daysAbsent: run,
            risk: run >= 10 ? "Critical" : run >= 5 ? "Warning" : "Monitor",
          });
        }
      }
      absences.sort((x, y) => y.daysAbsent - x.daysAbsent);
      const headcount = staff.rows.length;
      const expected = headcount - onLeaveIds.size;
      const attendancePercentToday = today === refDate ? (expected > 0 ? Math.round((presentToday / expected) * 100) : 0) : null;
      const attendance = {
        referenceDate: refDate,
        isToday: today === refDate,
        present: presentToday,
        absent: absentToday,
        onLeave: onLeaveIds.size,
        unauthorised: absences.length,
        consecutiveAlerts: absences.filter((x) => x.daysAbsent >= 5).length,
      };

      const resignations = await client.query(
        `SELECT r.id, r.employee_id, r.status, r.tentative_last_date, r.submitted_at,
                m.first_name, m.middle_name, m.last_name, (r.tentative_last_date - CURRENT_DATE) AS days_left
         FROM employee.resignation_request r JOIN employee.employee_master m ON m.id = r.employee_id
         WHERE r.status IN ('pending','approved') AND r.tentative_last_date >= CURRENT_DATE
         ORDER BY r.tentative_last_date LIMIT 20`
      );

      const pendingLeave = await client.query(
        `SELECT lr.id, lr.employee_id, lr.start_date, lr.end_date, lr.no_of_days, lt.name AS leave_type,
                m.first_name, m.middle_name, m.last_name
         FROM leave.leave_request lr
         JOIN employee.employee_master m ON m.id = lr.employee_id
         LEFT JOIN reference.leave_type lt ON lt.id = lr.leave_type_id
         WHERE lr.status = 'pending' ORDER BY lr.start_date LIMIT 20`
      );

      // UKVI events grouped by kind (scenario), for the "by Event Type" chart.
      const ukviKind = (scenario: string): string => {
        const t = scenario.toLowerCase();
        if (t.includes("absent")) return "Unauthorised absence";
        if (t.includes("fails to start") || t.includes("no show")) return "Did not start";
        if (t.includes("salary") || t.includes("pay drops")) return "Salary reduced";
        if (t.includes("job role") || t.includes("promotion")) return "Employment change";
        if (t.includes("location")) return "Work location change";
        return "Other";
      };
      const ukviByTypeMap = new Map<string, number>();
      for (const u of ukvi) ukviByTypeMap.set(ukviKind(u.scenario), (ukviByTypeMap.get(ukviKind(u.scenario)) ?? 0) + 1);

      // Document compliance: Active onboarded employees who have at least one uploaded supporting document.
      const docs = await client.query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM compliance.supporting_document d WHERE d.employee_id = m.id AND d.status = 'Uploaded')) AS with_docs
         FROM employee.employee_master m WHERE ${active}`
      );

      const fullName = (r: any) => [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(" ");
      const overdueUkvi = ukvi.filter((u) => u.status === "Overdue").length;
      return {
        attendancePercentToday,
        attendance,
        unauthorisedAbsences: absences.slice(0, 20),
        unauthorisedAbsenceCounts: {
          tenOrMore: absences.filter((x) => x.daysAbsent >= 10).length,
          underTen: absences.filter((x) => x.daysAbsent < 10).length,
        },
        expiry: { visa, cos, passport, rtw },
        ukvi: {
          total: ukvi.length,
          overdue: overdueUkvi,
          dueWithin7: ukvi.filter((u) => u.daysLeft >= 0 && u.daysLeft <= 7).length,
          dueWithin30: ukvi.filter((u) => u.daysLeft > 7 && u.daysLeft <= 30).length,
        },
        ukviByType: [...ukviByTypeMap.entries()].map(([label, count]) => ({ label, count })),
        documents: { totalEmployees: Number(docs.rows[0].total), withDocuments: Number(docs.rows[0].with_docs) },
        resignations: resignations.rows.map((r) => ({
          id: r.id,
          employeeId: r.employee_id,
          employeeName: fullName(r),
          status: r.status as string,
          lastWorkingDay: toDateStr(r.tentative_last_date),
          daysLeft: Number(r.days_left),
        })),
        pendingLeave: pendingLeave.rows.map((r) => ({
          id: r.id,
          employeeId: r.employee_id,
          employeeName: fullName(r),
          leaveType: r.leave_type ?? "Leave",
          startDate: toDateStr(r.start_date),
          endDate: toDateStr(r.end_date),
          days: Number(r.no_of_days),
        })),
      };
    });
  }
}
