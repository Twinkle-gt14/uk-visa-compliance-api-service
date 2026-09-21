import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { withTenant } from "../db";
import type { AttendanceDayDto, AttendanceDayRecordDto, AttendanceStatus } from "./attendance.dto";

const VALID_STATUSES: AttendanceStatus[] = ["present", "remote", "leave", "sick-leave", "absent"];

/** Same class of gap we found and fixed in the Employee module: a
 * missing/invalid field should be a clean 400, not a raw Postgres
 * error surfacing as a 500. */
function assertValidDay(day: AttendanceDayRecordDto): void {
  if (!day.date || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) {
    throw new BadRequestException(`Invalid or missing date: "${day.date}"`);
  }
  if (!VALID_STATUSES.includes(day.status)) {
    throw new BadRequestException(`Invalid status "${day.status}" - must be one of: ${VALID_STATUSES.join(", ")}`);
  }
  if (day.checkIn && day.checkOut) {
    const [inH, inM] = day.checkIn.split(":").map(Number);
    const [outH, outM] = day.checkOut.split(":").map(Number);
    if (outH * 60 + outM <= inH * 60 + inM) {
      throw new BadRequestException(`Check-out (${day.checkOut}) must be after check-in (${day.checkIn}) on ${day.date}`);
    }
  }
}

@Injectable()
export class AttendanceService {
  /** Attendance (and, separately, Leave) can only be marked on or after
   * the employee's actual joining date - a record dated before someone
   * even started doesn't mean anything. `date_of_joining` comes back as
   * a plain "YYYY-MM-DD" string (see db.ts's DATE type parser), so this
   * is a safe plain string comparison, not a Date object one. */
  private async assertOnOrAfterJoining(client: PoolClient, employeeId: string, dates: string[]): Promise<void> {
    const result = await client.query(
      "SELECT date_of_joining FROM employee.employee_master WHERE id = $1 AND NOT is_deleted",
      [employeeId]
    );
    if (!result.rowCount) throw new NotFoundException("Employee not found.");
    const joiningDate: string | null = result.rows[0].date_of_joining;
    if (!joiningDate) return; // no joining date on file yet - nothing to enforce against
    const earliest = dates.reduce((min, d) => (d < min ? d : min));
    if (earliest < joiningDate) {
      throw new BadRequestException(`Attendance cannot be marked before this employee's joining date (${joiningDate}).`);
    }
  }

  /** Days a timesheet can't be entered on: a bank holiday, or a day the employee is on leave (approved leave
   * or an existing leave / sick-leave attendance row). Back-dated days are fine otherwise. */
  private async blockedDates(client: PoolClient, employeeId: string, dates: string[]): Promise<Map<string, string>> {
    const blocked = new Map<string, string>();
    if (!dates.length) return blocked;
    const hol = await client.query("SELECT holiday_date FROM reference.holiday WHERE holiday_date = ANY($1::date[])", [dates]);
    for (const r of hol.rows) blocked.set(String(r.holiday_date).slice(0, 10), "a bank holiday");
    const att = await client.query(
      "SELECT record_date FROM attendance.attendance_record WHERE employee_id = $1 AND record_date = ANY($2::date[]) AND status IN ('leave', 'sick-leave')",
      [employeeId, dates]
    );
    for (const r of att.rows) blocked.set(String(r.record_date).slice(0, 10), "a day of leave");
    const lv = await client.query(
      "SELECT d::date AS d FROM unnest($2::date[]) AS d WHERE EXISTS (SELECT 1 FROM leave.leave_request lr WHERE lr.employee_id = $1 AND lr.status = 'approved' AND lr.start_date <= d AND lr.end_date >= d)",
      [employeeId, dates]
    );
    for (const r of lv.rows) blocked.set(String(r.d).slice(0, 10), "a day of leave");
    return blocked;
  }

  /** Returns only the days that actually have a recorded entry - a day
   * with no row is NOT "present" by default (the old frontend mock
   * fabricated a full month; this doesn't). Weekly-off/holiday
   * classification for blank days is the caller's responsibility,
   * since there's no holiday-calendar backend yet (Employee Module
   * Technical Design, Open Points). */
  async getMonth(
    tenantId: string,
    employeeId: string,
    year: number,
    month: number
  ): Promise<Record<number, AttendanceDayDto>> {
    return withTenant(tenantId, async (client) => {
      const startDate = `${year}-${String(month + 1).padStart(2, "0")}-01`;
      const endDate = new Date(year, month + 1, 0).toISOString().slice(0, 10);

      const result = await client.query(
        `SELECT record_date, status, check_in, check_out, note
         FROM attendance.attendance_record
         WHERE employee_id = $1 AND record_date BETWEEN $2 AND $3
         ORDER BY record_date`,
        [employeeId, startDate, endDate]
      );

      const records: Record<number, AttendanceDayDto> = {};
      for (const row of result.rows) {
        const day = new Date(row.record_date).getUTCDate();
        records[day] = {
          status: row.status,
          checkIn: row.check_in ? String(row.check_in).slice(0, 5) : null,
          checkOut: row.check_out ? String(row.check_out).slice(0, 5) : null,
          note: row.note,
        };
      }
      return records;
    });
  }

  async upsertDay(tenantId: string, employeeId: string, day: AttendanceDayRecordDto): Promise<{ date: string }> {
    assertValidDay(day);
    return withTenant(tenantId, async (client) => {
      await this.assertOnOrAfterJoining(client, employeeId, [day.date]);
      const blocked = await this.blockedDates(client, employeeId, [day.date]);
      if (blocked.has(day.date)) throw new BadRequestException(`A timesheet can't be entered for ${day.date}: it is ${blocked.get(day.date)}.`);
      await this.upsertOne(client, tenantId, employeeId, day);
      return { date: day.date };
    });
  }

  /** Upserts multiple days in one transaction - used by the "copy to
   * current week / current month / other days" options in the Add
   * Timesheet modal, so a partial failure can't leave some days
   * updated and others not. */
  async upsertBatch(tenantId: string, employeeId: string, days: AttendanceDayRecordDto[]): Promise<{ count: number }> {
    if (!days.length) {
      throw new BadRequestException("No records provided to upsert.");
    }
    days.forEach(assertValidDay);

    return withTenant(tenantId, async (client) => {
      await this.assertOnOrAfterJoining(client, employeeId, days.map((d) => d.date));
      // Copy-to-week/month leaves out holidays and leave days rather than failing the whole batch.
      const blocked = await this.blockedDates(client, employeeId, days.map((d) => d.date));
      const allowed = days.filter((d) => !blocked.has(d.date));
      for (const day of allowed) {
        await this.upsertOne(client, tenantId, employeeId, day);
      }
      return { count: allowed.length };
    });
  }

  private async upsertOne(client: PoolClient, tenantId: string, employeeId: string, day: AttendanceDayRecordDto) {
    try {
      await client.query(
        `INSERT INTO attendance.attendance_record (tenant_id, employee_id, record_date, status, check_in, check_out, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, employee_id, record_date) DO UPDATE SET
           status = EXCLUDED.status, check_in = EXCLUDED.check_in, check_out = EXCLUDED.check_out,
           note = EXCLUDED.note, updated_at = now()`,
        [tenantId, employeeId, day.date, day.status, day.checkIn || null, day.checkOut || null, day.note || null]
      );
    } catch (err: any) {
      if (err?.code === "23503") {
        // foreign_key_violation - employee_id doesn't reference a real employee
        throw new NotFoundException("Employee not found.");
      }
      throw err;
    }
  }
}
