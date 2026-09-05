import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { withTenant } from "../db";
import type {
  CreateResignationRequestDto,
  CurrentNoticePeriodDto,
  DecideResignationRequestDto,
  ResignationRequestDto,
} from "./resignation.dto";

function toDateStr(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function rowToResignationRequest(r: any): ResignationRequestDto {
  return {
    id: r.id,
    employeeId: r.employee_id,
    reason: r.reason,
    noticeDays: Number(r.notice_days),
    tentativeLastDate: toDateStr(r.tentative_last_date),
    status: r.status,
    submittedAt: r.submitted_at instanceof Date ? r.submitted_at.toISOString() : r.submitted_at,
    decidedAt: r.decided_at instanceof Date ? r.decided_at.toISOString() : r.decided_at,
    decidedByName: r.decided_by_name,
    decisionNote: r.decision_note,
  };
}

@Injectable()
export class ResignationService {
  /** Whichever Settings > HR > Notice Period row was created first -
   * see reference.notice_period's own doc-comment (migration 041) on
   * why "first" rather than any per-employee/per-policy selection,
   * which doesn't exist yet. Queried directly here (not via
   * SettingsService) so the Resignation page - which an employee-role
   * session must be able to read from - doesn't need to go through
   * SettingsController's HR-only guard just to see the current notice
   * period; Settings > HR > Notice Period's own Add/Edit/Delete screen
   * still goes through that guard as normal. */
  async getCurrentNoticePeriod(tenantId: string): Promise<CurrentNoticePeriodDto | null> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, name, notice_days FROM reference.notice_period WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`,
        [tenantId]
      );
      const r = result.rows[0];
      return r ? { id: r.id, name: r.name, noticeDays: Number(r.notice_days) } : null;
    });
  }

  async listResignationRequests(tenantId: string, employeeId?: string, status?: string): Promise<ResignationRequestDto[]> {
    return withTenant(tenantId, async (client) => {
      const conditions = ["tenant_id = $1"];
      const params: any[] = [tenantId];
      if (employeeId) {
        params.push(employeeId);
        conditions.push(`employee_id = $${params.length}`);
      }
      if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }
      const result = await client.query(
        `SELECT * FROM employee.resignation_request WHERE ${conditions.join(" AND ")} ORDER BY submitted_at DESC`,
        params
      );
      return result.rows.map(rowToResignationRequest);
    });
  }

  /** Rejects a second submission outright rather than allowing several
   * pending resignations to pile up for the same employee - the
   * tentative last date is only meaningful for one submission at a
   * time. An employee who wants to change their mind about the date
   * needs their existing pending request decided first (same
   * constraint leave.leave_request doesn't need, since overlapping
   * leave dates are a real, valid case leave already has its own
   * overlap-checking for - a second resignation is not). */
  async createResignationRequest(tenantId: string, dto: CreateResignationRequestDto): Promise<ResignationRequestDto> {
    const noticePeriod = await this.getCurrentNoticePeriod(tenantId);
    if (!noticePeriod) {
      throw new BadRequestException("No notice period is configured yet - ask HR to add one under Settings > HR > Notice Period.");
    }

    return withTenant(tenantId, async (client) => {
      const existing = await client.query(
        `SELECT id FROM employee.resignation_request WHERE tenant_id = $1 AND employee_id = $2 AND status = 'pending'`,
        [tenantId, dto.employeeId]
      );
      if (existing.rowCount) {
        throw new ConflictException("You already have a resignation request awaiting a decision.");
      }

      const result = await client.query(
        `INSERT INTO employee.resignation_request (tenant_id, employee_id, reason, notice_days, tentative_last_date)
         VALUES ($1, $2, $3, $4, CURRENT_DATE + ($4 || ' days')::interval)
         RETURNING *`,
        [tenantId, dto.employeeId, dto.reason || null, noticePeriod.noticeDays]
      );
      return rowToResignationRequest(result.rows[0]);
    });
  }

  async decideResignationRequest(tenantId: string, id: string, dto: DecideResignationRequestDto): Promise<ResignationRequestDto> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE employee.resignation_request
         SET status = $1, decided_at = now(), decided_by_name = $2, decision_note = $3
         WHERE id = $4 AND tenant_id = $5 AND status = 'pending'
         RETURNING *`,
        [dto.decision, dto.decidedByName || null, dto.decisionNote || null, id, tenantId]
      );
      if (!result.rowCount) throw new NotFoundException("Not found, or already decided.");
      return rowToResignationRequest(result.rows[0]);
    });
  }
}
