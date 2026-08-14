import { BadRequestException, ConflictException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { withTenant } from "../db";
import type {
  CreateLeaveRequestDto,
  DecideLeaveRequestDto,
  LeaveRequestDto,
  LeaveSummaryRowDto,
  LeaveTypeDto,
  UpdateLeaveTypeDto,
} from "./leave.dto";

/** Same class of bug fixed in Employee/Attendance: a Postgres DATE
 * column comes back from `pg` as a JS Date, not "YYYY-MM-DD". Applied
 * to every date field read back from leave.leave_request /
 * reference.leave_type. */
function toDateStr(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/** Parses a clean "YYYY-MM-DD" string into integer Y/M/D parts. Used
 * instead of ever comparing/mutating `Date` objects derived from
 * Postgres DATE columns directly - see the comment on
 * writeApprovedLeaveToAttendance() below for why. */
function parseYmd(dateStr: string): { y: number; m: number; d: number } {
  const [y, m, d] = dateStr.split("-").map(Number);
  return { y, m: m - 1, d };
}

/** Exact mirror of DEFAULT_LEAVE_ENTITLEMENTS in
 * lib/leave-entitlements.ts - seeded once per tenant on first use of
 * GET /leave/types, so a brand-new tenant sees the same defaults the
 * frontend has always shown from localStorage, instead of an empty
 * list. `slug` is the frontend's `id` field. */
const DEFAULT_LEAVE_TYPES: Array<Omit<LeaveTypeDto, "id">> = [
  { slug: "annual-leave", order: 1, name: "Annual Leave (Holiday)", category: "Statutory", paidUnpaid: "Paid", annualEntitlement: 28, carryForward: true, maxCarryForward: 5, selected: true },
  { slug: "sick-leave", order: 2, name: "Sick Leave", category: "Statutory", paidUnpaid: "Paid", annualEntitlement: 10, carryForward: true, maxCarryForward: 0, selected: true },
  { slug: "maternity-leave", order: 3, name: "Maternity Leave", category: "Statutory", paidUnpaid: "Paid", annualEntitlement: 90, carryForward: false, maxCarryForward: 0, selected: true },
  { slug: "paternity-leave", order: 4, name: "Paternity Leave", category: "Statutory", paidUnpaid: "Paid", annualEntitlement: 2, carryForward: false, maxCarryForward: 0, selected: false },
  { slug: "emergency-dependants-leave", order: 5, name: "Emergency Dependants Leave", category: "Statutory", paidUnpaid: "Unpaid", annualEntitlement: 5, carryForward: false, maxCarryForward: 0, selected: true },
  { slug: "carers-leave", order: 6, name: "Carer's Leave", category: "Statutory", paidUnpaid: "Unpaid", annualEntitlement: 5, carryForward: false, maxCarryForward: 0, selected: false },
  { slug: "study-leave", order: 7, name: "Study Leave", category: "Employer", paidUnpaid: "Unpaid", annualEntitlement: 3, carryForward: true, maxCarryForward: 2, selected: true },
  { slug: "personal-leave-unpaid", order: 8, name: "Personal Leave (Unpaid)", category: "Employer", paidUnpaid: "Unpaid", annualEntitlement: 2, carryForward: false, maxCarryForward: 0, selected: true },
];

/** Only Annual Leave and Sick Leave are prorated by joining date - same
 * business rule, same two slugs, as isProratedEntitlement() in
 * lib/leave-entitlements.ts. */
const PRORATED_SLUGS = ["annual-leave", "sick-leave"];

/** Port of getLeaveYearRange() in lib/leave-entitlements.ts: UK-style
 * leave year, 1 April to 31 March. Kept as plain date math (no library)
 * so it produces byte-identical boundaries to the frontend's version. */
function getLeaveYearRange(referenceDate: Date): { start: Date; end: Date } {
  const year = referenceDate.getFullYear();
  const isBeforeApril = referenceDate.getMonth() < 3;
  const startYear = isBeforeApril ? year - 1 : year;
  const start = new Date(Date.UTC(startYear, 3, 1));
  const end = new Date(Date.UTC(startYear + 1, 2, 31));
  return { start, end };
}

/** Port of prorateEntitlement() in lib/leave-entitlements.ts, same
 * rounding (nearest half day) and same "joined before the leave year /
 * joining date unknown -> full entitlement" rule. */
function prorateEntitlement(annualEntitlement: number, joiningDateIso: string | undefined | null, leaveYear: { start: Date; end: Date }): number {
  if (!joiningDateIso) return annualEntitlement;
  const joiningDate = new Date(joiningDateIso);
  if (Number.isNaN(joiningDate.getTime()) || joiningDate <= leaveYear.start) return annualEntitlement;
  if (joiningDate > leaveYear.end) return 0;

  const msPerDay = 86400000;
  const totalDays = Math.round((leaveYear.end.getTime() - leaveYear.start.getTime()) / msPerDay) + 1;
  const remainingDays = Math.round((leaveYear.end.getTime() - joiningDate.getTime()) / msPerDay) + 1;
  const prorated = (annualEntitlement * remainingDays) / totalDays;
  return Math.round(prorated * 2) / 2;
}

function rowToLeaveType(r: any): LeaveTypeDto {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    category: r.category,
    paidUnpaid: r.paid_unpaid,
    annualEntitlement: Number(r.annual_entitlement),
    carryForward: r.carry_forward,
    maxCarryForward: Number(r.max_carry_forward),
    selected: r.is_selected,
    order: r.sort_order,
  };
}

function rowToLeaveRequest(r: any): LeaveRequestDto {
  return {
    id: r.id,
    employeeId: r.employee_id,
    startDate: toDateStr(r.start_date),
    endDate: toDateStr(r.end_date),
    noOfDays: Number(r.no_of_days),
    leaveType: r.leave_type_name,
    leaveTypeId: r.leave_type_id,
    reason: r.reason,
    contactNumber: r.contact_number,
    documentFileName: r.document_file_reference,
    status: r.status,
    submittedAt: r.submitted_at instanceof Date ? r.submitted_at.toISOString() : r.submitted_at,
    decidedAt: r.decided_at instanceof Date ? r.decided_at.toISOString() : r.decided_at,
    decidedByName: r.decided_by_name,
    decisionNote: r.decision_note,
  };
}

@Injectable()
export class LeaveService {
  /** Returns the tenant's leave types, seeding the standard defaults on
   * first use. Settings > Leave Types today only edits this list in the
   * browser's localStorage (lib/leave-entitlements.ts); this is the
   * real, tenant-shared backing store the frontend should be pointed at
   * for that screen in a later round. */
  async listLeaveTypes(tenantId: string): Promise<LeaveTypeDto[]> {
    return withTenant(tenantId, async (client) => {
      const existing = await client.query("SELECT * FROM reference.leave_type ORDER BY sort_order");
      if (existing.rowCount) {
        return existing.rows.map(rowToLeaveType);
      }
      for (const t of DEFAULT_LEAVE_TYPES) {
        await client.query(
          `INSERT INTO reference.leave_type
            (tenant_id, slug, name, category, paid_unpaid, annual_entitlement, carry_forward, max_carry_forward, is_selected, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [tenantId, t.slug, t.name, t.category, t.paidUnpaid, t.annualEntitlement, t.carryForward, t.maxCarryForward, t.selected, t.order]
        );
      }
      const seeded = await client.query("SELECT * FROM reference.leave_type ORDER BY sort_order");
      return seeded.rows.map(rowToLeaveType);
    });
  }

  /** Resolves a leave type by either its display name (what the Apply
   * Leave dropdown submits, since it's populated from `.name`) or its
   * slug, so this endpoint works whether the caller has the display
   * name or already knows the stable slug. */
  private async resolveLeaveType(client: PoolClient, tenantId: string, nameOrSlug: string) {
    const result = await client.query(
      "SELECT * FROM reference.leave_type WHERE lower(name) = lower($1) OR slug = $1",
      [nameOrSlug]
    );
    if (!result.rowCount) {
      throw new BadRequestException(`Unknown leave type: "${nameOrSlug}". Check Settings \u203a Leave Types.`);
    }
    return result.rows[0];
  }

  private assertValidRequest(dto: CreateLeaveRequestDto): void {
    if (!dto.employeeId) throw new BadRequestException("employeeId is required.");
    if (!dto.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(dto.startDate)) {
      throw new BadRequestException(`Invalid or missing start date: "${dto.startDate}"`);
    }
    if (!dto.endDate || !/^\d{4}-\d{2}-\d{2}$/.test(dto.endDate)) {
      throw new BadRequestException(`Invalid or missing end date: "${dto.endDate}"`);
    }
    if (dto.endDate < dto.startDate) {
      throw new BadRequestException("End date must be on or after start date.");
    }
    if (!dto.leaveType?.trim()) throw new BadRequestException("leaveType is required.");
    if (!dto.reason?.trim()) throw new BadRequestException("A reason is required.");
    if (!dto.contactNumber?.trim()) throw new BadRequestException("A contact number is required.");
  }

  /** Real-backend version of findOverlappingRequests() in lib/leave-
   * requests.ts - the frontend only warns client-side using whatever
   * requests happen to be in that session's React state, so two
   * browser tabs (or a page refresh) could both submit overlapping
   * requests today. This makes the check authoritative: pending/
   * approved requests for the same employee that overlap the requested
   * range are a 409, not just a warning. */
  async createLeaveRequest(tenantId: string, dto: CreateLeaveRequestDto): Promise<LeaveRequestDto> {
    this.assertValidRequest(dto);

    return withTenant(tenantId, async (client) => {
      const leaveType = await this.resolveLeaveType(client, tenantId, dto.leaveType);

      const employeeExists = await client.query(
        "SELECT id FROM employee.employee_master WHERE id = $1 AND NOT is_deleted",
        [dto.employeeId]
      );
      if (!employeeExists.rowCount) throw new NotFoundException("Employee not found.");

      const overlap = await client.query(
        `SELECT id FROM leave.leave_request
         WHERE employee_id = $1 AND status IN ('pending', 'approved')
           AND start_date <= $3 AND end_date >= $2
         LIMIT 1`,
        [dto.employeeId, dto.startDate, dto.endDate]
      );
      if (overlap.rowCount) {
        throw new ConflictException("This employee already has a pending or approved leave request that overlaps these dates.");
      }

      const noOfDays = Math.round((new Date(dto.endDate).getTime() - new Date(dto.startDate).getTime()) / 86400000) + 1;

      const inserted = await client.query(
        `INSERT INTO leave.leave_request
          (tenant_id, employee_id, leave_type_id, start_date, end_date, no_of_days, reason, contact_number, document_file_reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [tenantId, dto.employeeId, leaveType.id, dto.startDate, dto.endDate, noOfDays, dto.reason, dto.contactNumber, dto.documentFileName || null]
      );

      return rowToLeaveRequest({ ...inserted.rows[0], leave_type_name: leaveType.name });
    });
  }

  async listLeaveRequests(tenantId: string, employeeId?: string, status?: string): Promise<LeaveRequestDto[]> {
    return withTenant(tenantId, async (client) => {
      const conditions: string[] = [];
      const values: any[] = [];
      let i = 1;
      if (employeeId) { conditions.push(`lr.employee_id = $${i++}`); values.push(employeeId); }
      if (status) { conditions.push(`lr.status = $${i++}`); values.push(status); }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

      const result = await client.query(
        `SELECT lr.*, lt.name AS leave_type_name
         FROM leave.leave_request lr
         JOIN reference.leave_type lt ON lt.id = lr.leave_type_id
         ${where}
         ORDER BY lr.submitted_at DESC`,
        values
      );
      return result.rows.map(rowToLeaveRequest);
    });
  }

  /** Mirrors buildLeaveSummaryRows() in lib/leave-entitlements.ts, but
   * with `approved` / `awaitingApproval` computed from real submitted
   * requests instead of a deterministic placeholder seed. `credited`
   * (mid-year manual credits/adjustments) and carried-forward balances
   * from a prior leave year are not tracked yet - both are 0 here,
   * same as a brand-new employee's row on the frontend today - and
   * would need a real crediting/year-end-rollover mechanism to be
   * accurate, which is a follow-up, not part of this round. */
  async getLeaveSummary(tenantId: string, employeeId: string, referenceDate: Date = new Date()): Promise<LeaveSummaryRowDto[]> {
    const leaveTypes = await this.listLeaveTypes(tenantId);
    const leaveYear = getLeaveYearRange(referenceDate);
    const yearStartStr = toDateStr(leaveYear.start);
    const yearEndStr = toDateStr(leaveYear.end);

    return withTenant(tenantId, async (client) => {
      const employeeRes = await client.query(
        "SELECT date_of_joining FROM employee.employee_master WHERE id = $1 AND NOT is_deleted",
        [employeeId]
      );
      if (!employeeRes.rowCount) throw new NotFoundException("Employee not found.");
      const joiningDateIso = toDateStr(employeeRes.rows[0].date_of_joining);

      const totalsRes = await client.query(
        `SELECT leave_type_id, status, COALESCE(SUM(no_of_days), 0) AS total_days
         FROM leave.leave_request
         WHERE employee_id = $1 AND status IN ('approved', 'pending')
           AND start_date <= $3 AND end_date >= $2
         GROUP BY leave_type_id, status`,
        [employeeId, yearStartStr, yearEndStr]
      );

      const totals = new Map<string, { approved: number; pending: number }>();
      for (const row of totalsRes.rows) {
        const entry = totals.get(row.leave_type_id) || { approved: 0, pending: 0 };
        if (row.status === "approved") entry.approved += Number(row.total_days);
        else entry.pending += Number(row.total_days);
        totals.set(row.leave_type_id, entry);
      }

      return leaveTypes
        .filter((lt) => lt.selected)
        .sort((a, b) => a.order - b.order)
        .map((leaveType): LeaveSummaryRowDto => {
          const annual = PRORATED_SLUGS.includes(leaveType.slug)
            ? prorateEntitlement(leaveType.annualEntitlement, joiningDateIso, leaveYear)
            : leaveType.annualEntitlement;
          const t = totals.get(leaveType.id) || { approved: 0, pending: 0 };
          const credited = 0; // no crediting/adjustment mechanism yet - see method doc comment
          const carriedIn = 0; // no leave-year rollover mechanism yet - see method doc comment
          const balance = annual + carriedIn + credited - t.approved - t.pending;
          return { leaveType, credited, approved: t.approved, awaitingApproval: t.pending, balance };
        });
    });
  }

  /** Writes one attendance.attendance_record row per weekday in
   * [startDateStr, endDateStr] inclusive.
   *
   * FIXED BUG: the original version built this range by comparing and
   * mutating `Date` objects derived directly from Postgres's
   * `leave_request.end_date` column (`new Date(request.end_date)`,
   * then `d <= end` / `d.setUTCDate(...)`). Depending on the Postgres
   * driver's DATE-parsing behaviour and the Node process's local
   * timezone, that `Date` object is not guaranteed to land exactly on
   * UTC midnight - it can end up a few hours off, which silently
   * excludes the final day from the `d <= end` comparison. Verified
   * against a real database: a Mon-Fri request was writing only
   * Mon-Thu, dropping Friday.
   *
   * The fix avoids `Date` object comparison entirely: both boundaries
   * are parsed as plain "YYYY-MM-DD" strings into integer Y/M/D parts,
   * converted to UTC millisecond timestamps via `Date.UTC()` (which is
   * unambiguous - no local-timezone interpretation involved), and the
   * loop advances by exactly 86400000ms (24h) per step - pure integer
   * arithmetic, no mutable Date object in the loop condition at all. */
  private async writeApprovedLeaveToAttendance(
    client: PoolClient,
    tenantId: string,
    employeeId: string,
    startDateStr: string,
    endDateStr: string,
    attendanceStatus: string,
    requestId: string
  ): Promise<void> {
    const { y: sy, m: sm, d: sd } = parseYmd(startDateStr);
    const { y: ey, m: em, d: ed } = parseYmd(endDateStr);
    const startMs = Date.UTC(sy, sm, sd);
    const endMs = Date.UTC(ey, em, ed);

    for (let cursorMs = startMs; cursorMs <= endMs; cursorMs += 86400000) {
      const cursor = new Date(cursorMs);
      const dayOfWeek = cursor.getUTCDay(); // 0 = Sunday, 6 = Saturday
      if (dayOfWeek === 0 || dayOfWeek === 6) continue;
      const dateStr = cursor.toISOString().slice(0, 10);
      await client.query(
        `INSERT INTO attendance.attendance_record (tenant_id, employee_id, record_date, status, note)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, employee_id, record_date) DO UPDATE SET
           status = EXCLUDED.status, note = EXCLUDED.note, updated_at = now()`,
        [tenantId, employeeId, dateStr, attendanceStatus, `Approved leave request ${requestId}`]
      );
    }
  }

  /** Approving/rejecting is the piece that genuinely didn't exist
   * anywhere before this - previously a request just sat as `status:
   * "pending"` in a page's local React state forever. On approval,
   * this also writes matching rows into attendance.attendance_record
   * (status 'leave' or 'sick-leave', per Attendance's existing status
   * enum) for each calendar day in range, skipping Saturdays/Sundays,
   * so the Attendance calendar reflects approved leave without a
   * second manual data-entry step - the cross-cutting consistency the
   * project brief calls for. Bank holidays are NOT excluded here (no
   * holiday-calendar backend exists yet - same open point Attendance
   * already has for the reason days show up as blank vs. Weekly Off).
   */
  async decideLeaveRequest(tenantId: string, id: string, dto: DecideLeaveRequestDto): Promise<LeaveRequestDto> {
    if (dto.decision !== "approved" && dto.decision !== "rejected") {
      throw new BadRequestException(`Invalid decision "${dto.decision}" - must be "approved" or "rejected".`);
    }

    return withTenant(tenantId, async (client) => {
      const existing = await client.query(
        `SELECT lr.*, lt.name AS leave_type_name, lt.slug AS leave_type_slug
         FROM leave.leave_request lr
         JOIN reference.leave_type lt ON lt.id = lr.leave_type_id
         WHERE lr.id = $1`,
        [id]
      );
      if (!existing.rowCount) throw new NotFoundException("Leave request not found.");
      const request = existing.rows[0];
      if (request.status !== "pending") {
        throw new BadRequestException(`This request is already ${request.status} and cannot be decided again.`);
      }

      const updated = await client.query(
        `UPDATE leave.leave_request
         SET status = $1, decided_at = now(), decided_by_name = $2, decision_note = $3, updated_at = now()
         WHERE id = $4
         RETURNING *`,
        [dto.decision, dto.decidedByName || null, dto.decisionNote || null, id]
      );

      if (dto.decision === "approved") {
        const attendanceStatus = request.leave_type_slug === "sick-leave" ? "sick-leave" : "leave";
        await this.writeApprovedLeaveToAttendance(
          client,
          tenantId,
          request.employee_id,
          toDateStr(request.start_date),
          toDateStr(request.end_date),
          attendanceStatus,
          id
        );
      }

      return rowToLeaveRequest({ ...updated.rows[0], leave_type_name: request.leave_type_name });
    });
  }

  /** Settings > Leave Types currently only edits this in the browser's
   * localStorage/React state - this is the real, tenant-shared
   * persistence layer that screen should be pointed at. */
  async updateLeaveType(tenantId: string, id: string, dto: UpdateLeaveTypeDto): Promise<LeaveTypeDto> {
    return withTenant(tenantId, async (client) => {
      const sets: string[] = [];
      const values: any[] = [];
      let i = 1;
      const set = (col: string, val: any) => { sets.push(`${col} = $${i++}`); values.push(val); };

      if (dto.name !== undefined) set("name", dto.name);
      if (dto.category !== undefined) set("category", dto.category);
      if (dto.paidUnpaid !== undefined) set("paid_unpaid", dto.paidUnpaid);
      if (dto.annualEntitlement !== undefined) set("annual_entitlement", dto.annualEntitlement);
      if (dto.carryForward !== undefined) set("carry_forward", dto.carryForward);
      if (dto.maxCarryForward !== undefined) set("max_carry_forward", dto.maxCarryForward);
      if (dto.selected !== undefined) set("is_selected", dto.selected);
      if (dto.order !== undefined) set("sort_order", dto.order);
      set("updated_at", new Date());

      values.push(id);
      const result = await client.query(
        `UPDATE reference.leave_type SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
        values
      );
      if (!result.rowCount) throw new NotFoundException("Leave type not found.");
      return rowToLeaveType(result.rows[0]);
    });
  }

  /** Lets an employee withdraw a request that hasn't been decided yet -
   * a real gap in the current scaffold, where a submitted request has
   * no way to be undone short of it never having been persisted at
   * all. Approved/rejected requests are left alone; cancelling those
   * would need its own audit trail (and, for an approved one, undoing
   * the attendance rows written above) which is out of scope here.
   *
   * `requesterEmployeeId` is passed for an employee-role session
   * cancelling their own request - checked against the row actually
   * fetched here (not just the id in the URL), so there's no gap
   * between "whose request is this" and "did we check that". Left
   * undefined for an hr_admin session, which can cancel anyone's. */
  async cancelLeaveRequest(tenantId: string, id: string, requesterEmployeeId?: string): Promise<LeaveRequestDto> {
    return withTenant(tenantId, async (client) => {
      const existing = await client.query(
        `SELECT lr.*, lt.name AS leave_type_name FROM leave.leave_request lr
         JOIN reference.leave_type lt ON lt.id = lr.leave_type_id WHERE lr.id = $1`,
        [id]
      );
      if (!existing.rowCount) throw new NotFoundException("Leave request not found.");
      if (requesterEmployeeId && existing.rows[0].employee_id !== requesterEmployeeId) {
        throw new UnauthorizedException("You can only cancel your own leave requests.");
      }
      if (existing.rows[0].status !== "pending") {
        throw new BadRequestException(`Only a pending request can be cancelled (this one is ${existing.rows[0].status}).`);
      }
      const updated = await client.query(
        "UPDATE leave.leave_request SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING *",
        [id]
      );
      return rowToLeaveRequest({ ...updated.rows[0], leave_type_name: existing.rows[0].leave_type_name });
    });
  }
}
