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
      for (const day of days) {
        await this.upsertOne(client, tenantId, employeeId, day);
      }
      return { count: days.length };
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
