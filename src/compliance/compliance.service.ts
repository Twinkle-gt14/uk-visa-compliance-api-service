import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import * as XLSX from "xlsx";
import { withTenant } from "../db";
import { parseAppendixTable, parseHealthcarePayBands, parseEducationPayScales } from "./appendix-parser";
import { randomUUID } from "crypto";
import {
  ALLOWED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  buildStorageKey,
  getSignedUploadUrl,
  getSignedDownloadUrl,
  verifyUploadedObject,
} from "../storage";

/** Postgres DATE columns come back from `pg` as JS Date objects, not
 * strings - String(dateObject) produces the full toString() format
 * ("Thu Aug 13 2026 00:00:00 GMT+...") rather than an ISO date, and
 * slicing the first 10 characters of *that* silently produces
 * garbage like "Thu Aug 13" instead of "2026-08-13". That garbled
 * value only ever caused a problem once something fed it back into a
 * save - see the assessmentDate/islRemovalDate mappings below. Same
 * fix already used in employee.service.ts's toDateStr(). */
function toDateStr(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
import type {
  SkilledWorkerListItemDto,
  SkilledWorkerSummaryCountsDto,
  SkilledWorkerDetailDto,
  SkilledWorkerRuleDto,
  UpdateSkilledWorkerRuleDto,
  ImportBatchDto,
  ImportBatchRecordDto,
  HealthcarePayBandDto,
  EducationPayScaleDto,
  SponsorshipAssessmentDto,
  CreateSponsorshipAssessmentDto,
  IslVersionDto,
  IslVersionRecordDto,
  IslLookupResultDto,
  SupportingDocumentDto,
  RequestUploadDto,
  RequestUploadResponseDto,
} from "./compliance.dto";

const GOV_UK_SOURCE_URL = "https://www.gov.uk/guidance/immigration-rules/immigration-rules-appendix-skilled-occupations";

/** Which sheets to parse as SOC-keyed Skilled Worker rule tables, and
 * the initial status each implies - per the Appendix workbook's own
 * README/Rules Summary recommendation: Tables 1/2/3 are the current
 * Skilled Worker core (Eligible); 1a/2aa/2a/3a are transitional/legacy
 * only; Table 2b is explicitly NOT part of Skilled Worker core (it's
 * Global Business Mobility); Table 6 is explicitly not eligible. This
 * app is scoped to the Skilled Worker route only, so a row's presence
 * in the workbook at all doesn't imply Skilled Worker eligibility -
 * the source table is what determines status, never guessed.
 */
const RULE_SHEETS: { sheet: string; sourceTable: string; status: SkilledWorkerRuleDto["status"] }[] = [
  { sheet: "Table_1", sourceTable: "Table 1", status: "Eligible" },
  { sheet: "Table_1a", sourceTable: "Table 1a", status: "Conditional" },
  { sheet: "Table_2", sourceTable: "Table 2", status: "Eligible" },
  { sheet: "Table_2aa", sourceTable: "Table 2aa", status: "Conditional" },
  { sheet: "Table_2a", sourceTable: "Table 2a", status: "Conditional" },
  { sheet: "Table_2b", sourceTable: "Table 2b", status: "Not Eligible" },
  { sheet: "Table_3", sourceTable: "Table 3", status: "Eligible" },
  { sheet: "Table_3a", sourceTable: "Table 3a", status: "Conditional" },
  { sheet: "Table_6", sourceTable: "Table 6", status: "Not Eligible" },
];

function rowToRuleDto(r: any): SkilledWorkerRuleDto {
  return {
    id: r.id,
    socCode: r.soc_code,
    sourceTable: r.source_table,
    status: r.status,
    homeOfficeRelatedJobTitles: r.home_office_related_job_titles ?? "",
    goingRate: r.going_rate != null ? Number(r.going_rate) : null,
    goingRate90: r.going_rate_90 != null ? Number(r.going_rate_90) : null,
    goingRate80: r.going_rate_80 != null ? Number(r.going_rate_80) : null,
    goingRate70: r.going_rate_70 != null ? Number(r.going_rate_70) : null,
    phdPointsEligible: r.phd_points_eligible,
    specialConditions: r.special_conditions ?? "",
    effectiveFrom: r.effective_from ? String(r.effective_from).slice(0, 10) : "",
    effectiveTo: r.effective_to ? String(r.effective_to).slice(0, 10) : null,
    sourceVersion: r.source_version ?? "",
    sourceUrl: r.source_url ?? "",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface ListFilters {
  search?: string;
  majorGroup?: string;
  subMajorGroup?: string;
  minorGroup?: string;
  status?: string;
  sourceTable?: string;
  effectiveStatus?: "Current" | "Historical" | "Future";
  page?: number;
  pageSize?: number;
}

@Injectable()
export class ComplianceService {
  /** Table-priority tiebreak for when one SOC code has more than one
   * active rule at once (a real, legitimate case - e.g. code 1111 is
   * genuinely active under both Table 1 and Table 2 simultaneously).
   * Only matters when a filter hasn't already narrowed to a single
   * source table: picks the broadest/most-primary table as the one
   * shown in the main grid, so the list stays one row per SOC code
   * rather than one row per matching rule. The full set is still
   * visible on the detail page regardless of which one wins here. */
  private static readonly SOURCE_TABLE_PRIORITY_SQL = `
    CASE sw.source_table
      WHEN 'Table 1' THEN 1 WHEN 'Table 2' THEN 2 WHEN 'Table 3' THEN 3
      WHEN 'Table 1a' THEN 4 WHEN 'Table 2aa' THEN 5 WHEN 'Table 2a' THEN 6 WHEN 'Table 3a' THEN 7
      WHEN 'Table 2b' THEN 8 WHEN 'Table 6' THEN 9 ELSE 10
    END
  `;

  async listSkilledWorkerOccupations(tenantId: string, filters: ListFilters) {
    return withTenant(tenantId, async (client) => {
      const page = filters.page ?? 1;
      const pageSize = filters.pageSize ?? 50;
      const offset = (page - 1) * pageSize;

      const where: string[] = [];
      const values: any[] = [];
      let i = 1;

      if (filters.search) {
        where.push(`(m.soc_code ILIKE $${i} OR m.soc_title ILIKE $${i} OR sw.home_office_related_job_titles ILIKE $${i})`);
        values.push(`%${filters.search}%`);
        i++;
      }
      if (filters.majorGroup) { where.push(`m.major_group = $${i++}`); values.push(filters.majorGroup); }
      if (filters.subMajorGroup) { where.push(`m.sub_major_group = $${i++}`); values.push(filters.subMajorGroup); }
      if (filters.minorGroup) { where.push(`m.minor_group = $${i++}`); values.push(filters.minorGroup); }
      if (filters.sourceTable) { where.push(`sw.source_table = $${i++}`); values.push(filters.sourceTable); }
      if (filters.status) {
        if (filters.status === "Not Mapped") where.push(`sw.id IS NULL`);
        else { where.push(`sw.status = $${i++}`); values.push(filters.status); }
      }
      if (filters.effectiveStatus === "Current") where.push(`sw.effective_from <= CURRENT_DATE`);
      if (filters.effectiveStatus === "Future") where.push(`sw.effective_from > CURRENT_DATE`);
      if (filters.effectiveStatus === "Historical") {
        where.push(`sw.id IS NULL AND EXISTS (
          SELECT 1 FROM compliance.skilled_worker_occupation_master h
          WHERE h.tenant_id = m.tenant_id AND h.soc_code = m.soc_code AND h.effective_to IS NOT NULL
        )`);
      }

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const priority = ComplianceService.SOURCE_TABLE_PRIORITY_SQL;

      // Filters (including sourceTable, if given) apply BEFORE the
      // DISTINCT ON collapse - so when a source table is explicitly
      // filtered, at most one row per SOC code already survives the
      // WHERE clause and the priority tiebreak below is a no-op.
      const listSql = `
        SELECT soc_code, soc_title, major_group, sub_major_group, minor_group,
               status, source_table, going_rate, going_rate_90, going_rate_80, going_rate_70, effective_from
        FROM (
          SELECT DISTINCT ON (m.soc_code)
            m.soc_code, m.soc_title, m.major_group, m.sub_major_group, m.minor_group,
            sw.status, sw.source_table, sw.going_rate, sw.going_rate_90, sw.going_rate_80,
            sw.going_rate_70, sw.effective_from
          FROM reference.soc_occupation_master m
          LEFT JOIN compliance.skilled_worker_occupation_master sw
            ON sw.tenant_id = m.tenant_id AND sw.soc_code = m.soc_code AND sw.effective_to IS NULL
          ${whereSql}
          ORDER BY m.soc_code, ${priority}
        ) ranked
        ORDER BY soc_code
        LIMIT $${i} OFFSET $${i + 1}
      `;
      values.push(pageSize, offset);

      const countSql = `
        SELECT count(*)::int AS n
        FROM (
          SELECT DISTINCT ON (m.soc_code) m.soc_code
          FROM reference.soc_occupation_master m
          LEFT JOIN compliance.skilled_worker_occupation_master sw
            ON sw.tenant_id = m.tenant_id AND sw.soc_code = m.soc_code AND sw.effective_to IS NULL
          ${whereSql}
          ORDER BY m.soc_code, ${priority}
        ) ranked
      `;

      const [listResult, countResult, summary] = await Promise.all([
        client.query(listSql, values),
        client.query(countSql, values.slice(0, -2)),
        this.computeSummary(client),
      ]);

      const items: SkilledWorkerListItemDto[] = listResult.rows.map((r) => ({
        socCode: r.soc_code,
        socTitle: r.soc_title ?? "",
        majorGroup: r.major_group ?? "",
        subMajorGroup: r.sub_major_group ?? "",
        minorGroup: r.minor_group ?? "",
        status: r.status ?? "Not Mapped",
        sourceTable: r.source_table,
        goingRate: r.going_rate != null ? Number(r.going_rate) : null,
        hasSalaryOptions: r.going_rate_90 != null || r.going_rate_80 != null || r.going_rate_70 != null,
        effectiveFrom: r.effective_from ? String(r.effective_from).slice(0, 10) : null,
      }));

      return { items, total: countResult.rows[0].n, page, pageSize, summary };
    });
  }

  /** Always the full, unfiltered 412-code picture (per SOC code, not
   * per rule) - shown as the dashboard-style summary regardless of
   * whatever filters are applied to the list below it. Uses the same
   * one-row-per-soc_code collapse as the list query, for the same
   * reason: a code active in two tables at once must only count once. */
  private async computeSummary(client: any): Promise<SkilledWorkerSummaryCountsDto> {
    const priority = ComplianceService.SOURCE_TABLE_PRIORITY_SQL;
    const result = await client.query(`
      WITH ranked AS (
        SELECT DISTINCT ON (m.soc_code) m.soc_code, sw.id, sw.status
        FROM reference.soc_occupation_master m
        LEFT JOIN compliance.skilled_worker_occupation_master sw
          ON sw.tenant_id = m.tenant_id AND sw.soc_code = m.soc_code AND sw.effective_to IS NULL
        ORDER BY m.soc_code, ${priority}
      )
      SELECT
        count(*)::int AS total,
        count(id) FILTER (WHERE id IS NOT NULL)::int AS mapped,
        count(*) FILTER (WHERE id IS NULL)::int AS not_mapped,
        count(*) FILTER (WHERE status = 'Eligible')::int AS eligible,
        count(*) FILTER (WHERE status = 'Not Eligible')::int AS not_eligible,
        count(*) FILTER (WHERE status = 'Conditional')::int AS conditional
      FROM ranked
    `);
    const r = result.rows[0];
    return {
      totalSocOccupations: r.total,
      mapped: r.mapped,
      notMapped: r.not_mapped,
      eligible: r.eligible,
      notEligible: r.not_eligible,
      conditional: r.conditional,
    };
  }

  async getSkilledWorkerDetail(tenantId: string, socCode: string): Promise<SkilledWorkerDetailDto> {
    return withTenant(tenantId, async (client) => {
      const socResult = await client.query(
        `SELECT soc_code, soc_title, major_group, major_group_title, sub_major_group, sub_major_group_title,
                minor_group, minor_group_title
         FROM reference.soc_occupation_master WHERE soc_code = $1`,
        [socCode]
      );
      if (!socResult.rowCount) throw new NotFoundException(`SOC code ${socCode} not found.`);
      const s = socResult.rows[0];

      const rulesResult = await client.query(
        `SELECT * FROM compliance.skilled_worker_occupation_master WHERE soc_code = $1 ORDER BY effective_from DESC`,
        [socCode]
      );
      const activeRules = rulesResult.rows.filter((r: any) => !r.effective_to).map(rowToRuleDto);
      const historicalRules = rulesResult.rows.filter((r: any) => r.effective_to).map(rowToRuleDto);

      return {
        soc: {
          socCode: s.soc_code,
          socTitle: s.soc_title ?? "",
          majorGroup: s.major_group ?? "",
          majorGroupTitle: s.major_group_title ?? "",
          subMajorGroup: s.sub_major_group ?? "",
          subMajorGroupTitle: s.sub_major_group_title ?? "",
          minorGroup: s.minor_group ?? "",
          minorGroupTitle: s.minor_group_title ?? "",
        },
        activeRules,
        historicalRules,
      };
    });
  }

  /** Never overwrites a rule in place - closes the current active
   * version (if one exists) for this soc_code/source_table and inserts
   * a new active version, per the required versioning model. */
  async updateSkilledWorkerRule(tenantId: string, socCode: string, dto: UpdateSkilledWorkerRuleDto): Promise<SkilledWorkerRuleDto> {
    return withTenant(tenantId, async (client) => {
      const socExists = await client.query("SELECT 1 FROM reference.soc_occupation_master WHERE soc_code = $1", [socCode]);
      if (!socExists.rowCount) throw new NotFoundException(`SOC code ${socCode} not found - cannot attach a rule to an unknown occupation.`);

      const effectiveFrom = dto.effectiveFrom || new Date().toISOString().slice(0, 10);

      const current = await client.query(
        `SELECT id, effective_from FROM compliance.skilled_worker_occupation_master
         WHERE tenant_id = $1 AND soc_code = $2 AND source_table = $3 AND effective_to IS NULL`,
        [tenantId, socCode, dto.sourceTable]
      );
      if (current.rowCount) {
        const closeDate = new Date(effectiveFrom);
        closeDate.setDate(closeDate.getDate() - 1);
        await client.query(
          `UPDATE compliance.skilled_worker_occupation_master SET effective_to = $1, updated_at = now() WHERE id = $2`,
          [closeDate.toISOString().slice(0, 10), current.rows[0].id]
        );
      }

      const inserted = await client.query(
        `INSERT INTO compliance.skilled_worker_occupation_master
          (tenant_id, soc_code, source_table, status, home_office_related_job_titles, going_rate, going_rate_90,
           going_rate_80, going_rate_70, phd_points_eligible, special_conditions, effective_from, source_version, source_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          tenantId, socCode, dto.sourceTable, dto.status, dto.homeOfficeRelatedJobTitles || null,
          dto.goingRate ?? null, dto.goingRate90 ?? null, dto.goingRate80 ?? null, dto.goingRate70 ?? null,
          dto.phdPointsEligible ?? null, dto.specialConditions || null, effectiveFrom,
          dto.sourceVersion || null, dto.sourceUrl || null,
        ]
      );
      return rowToRuleDto(inserted.rows[0]);
    });
  }

  // --- Import workflow ---

  async previewImport(tenantId: string, fileBuffer: Buffer, filename: string): Promise<ImportBatchDto> {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(fileBuffer, { type: "buffer" });
    } catch {
      throw new BadRequestException("Couldn't read that file - is it a valid .xlsx spreadsheet?");
    }

    const today = new Date().toISOString().slice(0, 10);

    return withTenant(tenantId, async (client) => {
      const socCodes = new Set<string>(
        (await client.query("SELECT soc_code FROM reference.soc_occupation_master")).rows.map((r: any) => r.soc_code)
      );

      const seenInBatch = new Set<string>();
      const staged: { socCode: string | null; sourceTable: string; outcome: string; raw: any; parsed?: any }[] = [];

      for (const { sheet: sheetName, sourceTable, status } of RULE_SHEETS) {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) continue;
        const rows = parseAppendixTable(sheet);
        for (const row of rows) {
          if (!row.socCode) {
            staged.push({ socCode: null, sourceTable, outcome: "Invalid", raw: row.raw });
            continue;
          }
          const key = `${row.socCode}::${sourceTable}`;
          if (seenInBatch.has(key)) {
            staged.push({ socCode: row.socCode, sourceTable, outcome: "Duplicate", raw: row.raw });
            continue;
          }
          seenInBatch.add(key);

          if (!socCodes.has(row.socCode)) {
            staged.push({ socCode: row.socCode, sourceTable, outcome: "Not Matched", raw: row.raw });
            continue;
          }

          const existingActive = await client.query(
            `SELECT 1 FROM compliance.skilled_worker_occupation_master
             WHERE tenant_id = $1 AND soc_code = $2 AND source_table = $3 AND effective_to IS NULL AND effective_from = $4`,
            [tenantId, row.socCode, sourceTable, today]
          );
          if (existingActive.rowCount) {
            staged.push({ socCode: row.socCode, sourceTable, outcome: "Duplicate", raw: row.raw });
            continue;
          }

          staged.push({
            socCode: row.socCode,
            sourceTable,
            outcome: "Matched",
            raw: row.raw,
            parsed: { ...row, status },
          });
        }
      }

      // Table 4 & 5 - no soc_code, staged as pure reference upserts.
      if (workbook.Sheets["Table_4"]) {
        for (const band of parseHealthcarePayBands(workbook.Sheets["Table_4"])) {
          staged.push({ socCode: null, sourceTable: "Table 4", outcome: "Matched", raw: band, parsed: band });
        }
      }
      if (workbook.Sheets["Table_5"]) {
        for (const role of parseEducationPayScales(workbook.Sheets["Table_5"])) {
          staged.push({ socCode: null, sourceTable: "Table 5", outcome: "Matched", raw: role, parsed: role });
        }
      }

      const counts = {
        matched: staged.filter((s) => s.outcome === "Matched").length,
        notMatched: staged.filter((s) => s.outcome === "Not Matched").length,
        duplicate: staged.filter((s) => s.outcome === "Duplicate").length,
        invalid: staged.filter((s) => s.outcome === "Invalid").length,
      };

      const batchResult = await client.query(
        `INSERT INTO compliance.import_batch (tenant_id, source_filename, status, matched_count, unmatched_count, duplicate_count, invalid_count)
         VALUES ($1,$2,'Pending Review',$3,$4,$5,$6) RETURNING *`,
        [tenantId, filename, counts.matched, counts.notMatched, counts.duplicate, counts.invalid]
      );
      const batch = batchResult.rows[0];

      for (const s of staged) {
        await client.query(
          `INSERT INTO compliance.import_batch_record (batch_id, tenant_id, soc_code, source_table, outcome, raw_row_json)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [batch.id, tenantId, s.socCode, s.sourceTable, s.outcome, JSON.stringify(s.parsed ?? s.raw)]
        );
      }

      return this.buildImportBatchDto(client, batch.id);
    });
  }

  async getImportBatch(tenantId: string, batchId: string): Promise<ImportBatchDto> {
    return withTenant(tenantId, (client) => this.buildImportBatchDto(client, batchId));
  }

  /** Builds the ImportBatchDto using an already-open client/transaction
   * - never opens its own connection via withTenant(). Calling
   * withTenant() from inside another withTenant() block would run on a
   * second, separate connection that can't see the outer transaction's
   * uncommitted writes yet (e.g. a batch just INSERTed moments earlier
   * in the same request) - that mismatch is exactly what caused
   * "Import batch not found" right after a fresh upload. This helper
   * is what previewImport/approveImport/cancelImport call internally;
   * the public getImportBatch() above is the only place that opens a
   * fresh transaction for a standalone fetch. */
  private async buildImportBatchDto(client: any, batchId: string): Promise<ImportBatchDto> {
    const batchResult = await client.query("SELECT * FROM compliance.import_batch WHERE id = $1", [batchId]);
    if (!batchResult.rowCount) throw new NotFoundException("Import batch not found.");
    const b = batchResult.rows[0];

    const recordsResult = await client.query(
      `SELECT r.id, r.soc_code, r.source_table, r.outcome, m.soc_title
       FROM compliance.import_batch_record r
       LEFT JOIN reference.soc_occupation_master m ON m.tenant_id = r.tenant_id AND m.soc_code = r.soc_code
       WHERE r.batch_id = $1
       ORDER BY r.source_table, r.soc_code`,
      [batchId]
    );

    const records: ImportBatchRecordDto[] = recordsResult.rows.map((r: any) => ({
      id: r.id,
      socCode: r.soc_code,
      sourceTable: r.source_table,
      outcome: r.outcome,
      occupationTitle: r.soc_title ?? null,
    }));

    return {
      id: b.id,
      sourceFilename: b.source_filename ?? "",
      status: b.status,
      matchedCount: b.matched_count,
      unmatchedCount: b.unmatched_count,
      duplicateCount: b.duplicate_count,
      invalidCount: b.invalid_count,
      uploadedAt: b.uploaded_at,
      reviewedAt: b.reviewed_at,
      records,
    };
  }

  async approveImport(tenantId: string, batchId: string): Promise<ImportBatchDto> {
    return withTenant(tenantId, async (client) => {
      const batchResult = await client.query("SELECT * FROM compliance.import_batch WHERE id = $1", [batchId]);
      if (!batchResult.rowCount) throw new NotFoundException("Import batch not found.");
      if (batchResult.rows[0].status !== "Pending Review") {
        throw new BadRequestException(`This import batch is already ${batchResult.rows[0].status} and cannot be approved again.`);
      }

      const matchedRecords = await client.query(
        `SELECT * FROM compliance.import_batch_record WHERE batch_id = $1 AND outcome = 'Matched'`,
        [batchId]
      );

      const today = new Date().toISOString().slice(0, 10);

      for (const rec of matchedRecords.rows) {
        const data = rec.raw_row_json;

        if (rec.source_table === "Table 4") {
          await client.query(
            `INSERT INTO reference.healthcare_pay_band (tenant_id, band_label, england, scotland, wales, northern_ireland)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (tenant_id, band_label) DO UPDATE SET
               england = EXCLUDED.england, scotland = EXCLUDED.scotland, wales = EXCLUDED.wales,
               northern_ireland = EXCLUDED.northern_ireland, uploaded_at = now()`,
            [tenantId, data.bandLabel, data.england, data.scotland, data.wales, data.northernIreland]
          );
          continue;
        }
        if (rec.source_table === "Table 5") {
          await client.query(
            `INSERT INTO reference.education_pay_scale (tenant_id, role_label, england, london_fringe, outer_london, inner_london, scotland, wales, northern_ireland)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (tenant_id, role_label) DO UPDATE SET
               england = EXCLUDED.england, london_fringe = EXCLUDED.london_fringe, outer_london = EXCLUDED.outer_london,
               inner_london = EXCLUDED.inner_london, scotland = EXCLUDED.scotland, wales = EXCLUDED.wales,
               northern_ireland = EXCLUDED.northern_ireland, uploaded_at = now()`,
            [tenantId, data.roleLabel, data.england, data.londonFringe, data.outerLondon, data.innerLondon, data.scotland, data.wales, data.northernIreland]
          );
          continue;
        }

        // Standard SOC-keyed rule row - version in, same logic as a manual edit.
        const existingActive = await client.query(
          `SELECT id FROM compliance.skilled_worker_occupation_master
           WHERE tenant_id = $1 AND soc_code = $2 AND source_table = $3 AND effective_to IS NULL`,
          [tenantId, rec.soc_code, rec.source_table]
        );
        if (existingActive.rowCount) {
          const closeDate = new Date(today);
          closeDate.setDate(closeDate.getDate() - 1);
          await client.query(
            `UPDATE compliance.skilled_worker_occupation_master SET effective_to = $1, updated_at = now() WHERE id = $2`,
            [closeDate.toISOString().slice(0, 10), existingActive.rows[0].id]
          );
        }

        const insertResult = await client.query(
          `INSERT INTO compliance.skilled_worker_occupation_master
            (tenant_id, soc_code, source_table, status, home_office_related_job_titles, going_rate, going_rate_90,
             going_rate_80, going_rate_70, phd_points_eligible, special_conditions, effective_from, source_version, source_url)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING id`,
          [
            tenantId, rec.soc_code, rec.source_table, data.status, data.relatedJobTitles || null,
            data.goingRate ?? null, data.goingRate90 ?? null, data.goingRate80 ?? null, data.goingRate70 ?? null,
            data.phdPointsEligible ?? null, data.rateNote || null, today,
            `Appendix Skilled Occupations - imported ${today}`, GOV_UK_SOURCE_URL,
          ]
        );
        await client.query(`UPDATE compliance.import_batch_record SET resolved_skilled_worker_id = $1 WHERE id = $2`, [insertResult.rows[0].id, rec.id]);
      }

      await client.query(
        `UPDATE compliance.import_batch SET status = 'Approved', reviewed_at = now() WHERE id = $1`,
        [batchId]
      );

      return this.buildImportBatchDto(client, batchId);
    });
  }

  async cancelImport(tenantId: string, batchId: string): Promise<ImportBatchDto> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE compliance.import_batch SET status = 'Cancelled', reviewed_at = now() WHERE id = $1 AND status = 'Pending Review' RETURNING id`,
        [batchId]
      );
      if (!result.rowCount) throw new NotFoundException("Import batch not found or already reviewed.");
      return this.buildImportBatchDto(client, batchId);
    });
  }

  async listImportBatches(tenantId: string): Promise<ImportBatchDto[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query("SELECT * FROM compliance.import_batch ORDER BY uploaded_at DESC LIMIT 20");
      return result.rows.map((b: any) => ({
        id: b.id,
        sourceFilename: b.source_filename ?? "",
        status: b.status,
        matchedCount: b.matched_count,
        unmatchedCount: b.unmatched_count,
        duplicateCount: b.duplicate_count,
        invalidCount: b.invalid_count,
        uploadedAt: b.uploaded_at,
        reviewedAt: b.reviewed_at,
      }));
    });
  }

  // --- Table 4 / 5 standalone reference data ---

  async listHealthcarePayBands(tenantId: string): Promise<HealthcarePayBandDto[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query("SELECT * FROM reference.healthcare_pay_band ORDER BY band_label");
      return result.rows.map((r: any) => ({
        id: r.id, bandLabel: r.band_label,
        england: r.england != null ? Number(r.england) : null,
        scotland: r.scotland != null ? Number(r.scotland) : null,
        wales: r.wales != null ? Number(r.wales) : null,
        northernIreland: r.northern_ireland != null ? Number(r.northern_ireland) : null,
      }));
    });
  }

  async listEducationPayScales(tenantId: string): Promise<EducationPayScaleDto[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query("SELECT * FROM reference.education_pay_scale ORDER BY role_label");
      return result.rows.map((r: any) => ({
        id: r.id, roleLabel: r.role_label,
        england: r.england != null ? Number(r.england) : null,
        londonFringe: r.london_fringe != null ? Number(r.london_fringe) : null,
        outerLondon: r.outer_london != null ? Number(r.outer_london) : null,
        innerLondon: r.inner_london != null ? Number(r.inner_london) : null,
        scotland: r.scotland != null ? Number(r.scotland) : null,
        wales: r.wales != null ? Number(r.wales) : null,
        northernIreland: r.northern_ireland != null ? Number(r.northern_ireland) : null,
      }));
    });
  }

  // --- Immigration Salary List (ISL) - per
  // UKVisaCompliance_FSD_Immigration_Salary_List_Master (updated).
  // Expected import columns (case-sensitive header match; adjust once
  // a real Home Office-derived template is available, same as the
  // SOC2020/Appendix parsers were tuned against real files before
  // going live): "SOC 2020 Code", "Occupation Criteria",
  // "UK Jurisdiction", "ISL Listed", "Jurisdiction Criteria",
  // "Removal Date", "Source Version", "Effective From",
  // "Effective To", "Source URL". One row per (SOC code, jurisdiction)
  // combination, per FSD 10.4.

  private static pickCell(row: Record<string, any>, ...headers: string[]): any {
    for (const h of headers) if (h in row && row[h] != null) return row[h];
    return null;
  }

  private static parseIslRow(row: Record<string, any>) {
    const socCode = ComplianceService.pickCell(row, "SOC 2020 Code", "soc_2020_code", "SOC Code");
    const jurisdictionName = ComplianceService.pickCell(row, "UK Jurisdiction", "Jurisdiction", "uk_jurisdiction");
    const listedRaw = ComplianceService.pickCell(row, "ISL Listed", "is_listed", "Listed");
    const isListed = listedRaw == null ? null : /^(yes|true|1)$/i.test(String(listedRaw).trim());
    return {
      socCode: socCode != null ? String(socCode).trim() : null,
      occupationCriteria: ComplianceService.pickCell(row, "Occupation Criteria", "Occupation / ISL Criteria", "occupation_criteria"),
      jurisdictionName: jurisdictionName != null ? String(jurisdictionName).trim() : null,
      isListed,
      jurisdictionCriteria: ComplianceService.pickCell(row, "Jurisdiction Criteria", "jurisdiction_criteria"),
      removalDate: ComplianceService.pickCell(row, "Removal Date", "removal_date"),
      sourceVersion: ComplianceService.pickCell(row, "Source Version", "source_version"),
      effectiveFrom: ComplianceService.pickCell(row, "Effective From", "effective_from"),
      effectiveTo: ComplianceService.pickCell(row, "Effective To", "effective_to"),
      sourceUrl: ComplianceService.pickCell(row, "Source URL", "source_url"),
    };
  }

  /** Parses the uploaded ISL workbook and stages every row against
   * this new Draft version - nothing is written to isl_occupation /
   * isl_jurisdiction_applicability until publishIslVersion() is
   * called, mirroring the Appendix import's preview-before-write
   * principle (FSD 10.3: "preview... before publication"). */
  async previewIslImport(tenantId: string, fileBuffer: Buffer, filename: string, userId: string | undefined): Promise<IslVersionDto> {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(fileBuffer, { type: "buffer" });
    } catch {
      throw new BadRequestException("Couldn't read that file - is it a valid .xlsx spreadsheet?");
    }
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: null });
    if (!rows.length) throw new BadRequestException("That file has no data rows.");

    return withTenant(tenantId, async (client) => {
      const socCodes = new Set<string>(
        (await client.query("SELECT soc_code FROM reference.soc_occupation_master")).rows.map((r: any) => r.soc_code)
      );
      const jurisdictions = await client.query("SELECT id, name FROM reference.uk_jurisdiction WHERE is_active");
      const jurisdictionByName = new Map<string, string>(
        jurisdictions.rows.map((r: any) => [r.name.toLowerCase(), r.id])
      );

      const versionResult = await client.query(
        `INSERT INTO compliance.isl_version (tenant_id, status, source_filename, uploaded_by)
         VALUES ($1,'Draft',$2,$3) RETURNING id`,
        [tenantId, filename, userId || null]
      );
      const versionId = versionResult.rows[0].id;

      const seen = new Set<string>();
      let matched = 0, notMatched = 0, duplicate = 0, invalid = 0;

      for (const row of rows) {
        const parsed = ComplianceService.parseIslRow(row);
        let outcome: "Matched" | "Not Matched" | "Duplicate" | "Invalid";

        if (!parsed.socCode || !parsed.jurisdictionName) {
          outcome = "Invalid";
          invalid++;
        } else {
          const key = `${parsed.socCode}::${parsed.jurisdictionName.toLowerCase()}`;
          if (seen.has(key)) {
            outcome = "Duplicate";
            duplicate++;
          } else {
            seen.add(key);
            if (!socCodes.has(parsed.socCode) || !jurisdictionByName.has(parsed.jurisdictionName.toLowerCase())) {
              outcome = "Not Matched";
              notMatched++;
            } else {
              outcome = "Matched";
              matched++;
            }
          }
        }

        await client.query(
          `INSERT INTO compliance.isl_version_record (isl_version_id, tenant_id, soc_2020_code, outcome, raw_row_json)
           VALUES ($1,$2,$3,$4,$5)`,
          [versionId, tenantId, parsed.socCode, outcome, JSON.stringify(parsed)]
        );
      }

      await client.query(
        `UPDATE compliance.isl_version SET matched_count=$1, not_matched_count=$2, duplicate_count=$3, invalid_count=$4 WHERE id=$5`,
        [matched, notMatched, duplicate, invalid, versionId]
      );

      return this.buildIslVersionDto(client, versionId);
    });
  }

  private async buildIslVersionDto(client: any, versionId: string): Promise<IslVersionDto> {
    const vResult = await client.query("SELECT * FROM compliance.isl_version WHERE id = $1", [versionId]);
    if (!vResult.rowCount) throw new NotFoundException("ISL version not found.");
    const v = vResult.rows[0];

    const recordsResult = await client.query(
      `SELECT r.id, r.soc_2020_code, r.outcome, r.raw_row_json, m.soc_title
       FROM compliance.isl_version_record r
       LEFT JOIN reference.soc_occupation_master m ON m.tenant_id = r.tenant_id AND m.soc_code = r.soc_2020_code
       WHERE r.isl_version_id = $1
       ORDER BY r.soc_2020_code`,
      [versionId]
    );
    const records: IslVersionRecordDto[] = recordsResult.rows.map((r: any) => ({
      id: r.id,
      socCode: r.soc_2020_code,
      outcome: r.outcome,
      occupationTitle: r.soc_title ?? null,
      jurisdiction: r.raw_row_json?.jurisdictionName ?? null,
      isListed: r.raw_row_json?.isListed ?? null,
    }));

    return {
      id: v.id,
      status: v.status,
      sourceFilename: v.source_filename ?? "",
      sourceVersion: v.source_version ?? "",
      sourceUrl: v.source_url ?? "",
      effectiveFrom: v.effective_from ? String(v.effective_from).slice(0, 10) : null,
      effectiveTo: v.effective_to ? String(v.effective_to).slice(0, 10) : null,
      uploadedBy: v.uploaded_by,
      uploadedAt: v.uploaded_at,
      publishedBy: v.published_by,
      publishedAt: v.published_at,
      matchedCount: v.matched_count,
      notMatchedCount: v.not_matched_count,
      duplicateCount: v.duplicate_count,
      invalidCount: v.invalid_count,
      records,
    };
  }

  async getIslVersion(tenantId: string, versionId: string): Promise<IslVersionDto> {
    return withTenant(tenantId, (client) => this.buildIslVersionDto(client, versionId));
  }

  async listIslVersions(tenantId: string): Promise<IslVersionDto[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query("SELECT id FROM compliance.isl_version ORDER BY uploaded_at DESC LIMIT 20");
      const versions: IslVersionDto[] = [];
      for (const row of result.rows) {
        versions.push(await this.buildIslVersionDto(client, row.id));
      }
      return versions;
    });
  }

  /** Publishes a Draft version: groups its Matched records by SOC
   * code into isl_occupation rows, creates the per-jurisdiction
   * isl_jurisdiction_applicability children, then supersedes whatever
   * version was previously Published (never edits it - FSD 10.5: "A
   * published version must not be edited in place"). Only one
   * Published version is treated as currently active at a time. */
  async publishIslVersion(tenantId: string, versionId: string, userId: string | undefined, sourceVersion?: string, sourceUrl?: string): Promise<IslVersionDto> {
    return withTenant(tenantId, async (client) => {
      const vResult = await client.query("SELECT * FROM compliance.isl_version WHERE id = $1", [versionId]);
      if (!vResult.rowCount) throw new NotFoundException("ISL version not found.");
      if (vResult.rows[0].status !== "Draft") {
        throw new BadRequestException(`This ISL version is already ${vResult.rows[0].status} and cannot be published again.`);
      }

      const matchedRecords = await client.query(
        `SELECT * FROM compliance.isl_version_record WHERE isl_version_id = $1 AND outcome = 'Matched'`,
        [versionId]
      );
      if (!matchedRecords.rowCount) {
        throw new BadRequestException("This version has no matched rows to publish.");
      }

      const jurisdictions = await client.query("SELECT id, name FROM reference.uk_jurisdiction WHERE is_active");
      const jurisdictionIdByName = new Map<string, string>(
        jurisdictions.rows.map((r: any) => [r.name.toLowerCase(), r.id])
      );

      // Group by SOC code - one isl_occupation row per code, using the
      // first row's occupation-level fields (criteria/removal/effective
      // dates), then one applicability child per jurisdiction row.
      const bySocCode = new Map<string, any[]>();
      for (const rec of matchedRecords.rows) {
        const list = bySocCode.get(rec.soc_2020_code) ?? [];
        list.push(rec.raw_row_json);
        bySocCode.set(rec.soc_2020_code, list);
      }

      for (const [socCode, rows] of bySocCode) {
        const first = rows[0];
        const occResult = await client.query(
          `INSERT INTO compliance.isl_occupation
            (tenant_id, isl_version_id, soc_2020_code, occupation_criteria, removal_date, effective_from, effective_to, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,true)
           RETURNING id`,
          [
            tenantId, versionId, socCode, first.occupationCriteria || null,
            first.removalDate || null, first.effectiveFrom || new Date().toISOString().slice(0, 10),
            first.effectiveTo || null,
          ]
        );
        const occupationId = occResult.rows[0].id;

        for (const row of rows) {
          const jurisdictionId = jurisdictionIdByName.get(String(row.jurisdictionName).toLowerCase());
          if (!jurisdictionId) continue; // shouldn't happen - already validated as Matched
          await client.query(
            `INSERT INTO compliance.isl_jurisdiction_applicability
              (tenant_id, isl_occupation_id, jurisdiction_id, is_listed, jurisdiction_criteria)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (isl_occupation_id, jurisdiction_id) DO UPDATE SET
               is_listed = EXCLUDED.is_listed, jurisdiction_criteria = EXCLUDED.jurisdiction_criteria`,
            [tenantId, occupationId, jurisdictionId, row.isListed ?? false, row.jurisdictionCriteria || null]
          );
        }
      }

      // Supersede whatever was previously Published - never edited in place.
      await client.query(
        `UPDATE compliance.isl_version SET status = 'Superseded' WHERE tenant_id = $1 AND status = 'Published' AND id != $2`,
        [tenantId, versionId]
      );

      await client.query(
        `UPDATE compliance.isl_version
         SET status = 'Published', published_by = $1, published_at = now(), source_version = $2, source_url = $3
         WHERE id = $4`,
        [userId || null, sourceVersion || null, sourceUrl || null, versionId]
      );

      return this.buildIslVersionDto(client, versionId);
    });
  }

  async rejectIslVersion(tenantId: string, versionId: string): Promise<IslVersionDto> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE compliance.isl_version SET status = 'Rejected' WHERE id = $1 AND status = 'Draft' RETURNING id`,
        [versionId]
      );
      if (!result.rowCount) throw new NotFoundException("ISL version not found or already reviewed.");
      return this.buildIslVersionDto(client, versionId);
    });
  }

  /** Read-only lookup for the Immigration / Sponsorship Assessment
   * screen (FSD section 5 & 8). Resolves against whichever ISL version
   * is currently Published - never against Draft/Superseded/Rejected
   * data (FSD 7: "Expired ISL records must not be used for a new
   * assessment"). Returns found: false rather than fabricating a
   * result when there's no published data, no match for this SOC
   * code, or the work location's jurisdiction isn't set. */
  async getIslLookup(tenantId: string, socCode: string, jurisdictionName: string | null): Promise<IslLookupResultDto> {
    const empty: IslLookupResultDto = {
      found: false, isListed: null, jurisdiction: jurisdictionName, occupationCriteria: null,
      jurisdictionCriteria: null, removalDate: null, sourceVersion: null, sourceUrl: null,
    };
    if (!jurisdictionName) return empty;

    return withTenant(tenantId, async (client) => {
      const occResult = await client.query(
        `SELECT o.* FROM compliance.isl_occupation o
         JOIN compliance.isl_version v ON v.id = o.isl_version_id
         WHERE v.tenant_id = $1 AND v.status = 'Published' AND o.soc_2020_code = $2`,
        [tenantId, socCode]
      );
      if (!occResult.rowCount) return empty;
      const occupation = occResult.rows[0];

      const applicabilityResult = await client.query(
        `SELECT a.* FROM compliance.isl_jurisdiction_applicability a
         JOIN reference.uk_jurisdiction j ON j.id = a.jurisdiction_id
         WHERE a.isl_occupation_id = $1 AND lower(j.name) = lower($2)`,
        [occupation.id, jurisdictionName]
      );
      if (!applicabilityResult.rowCount) return empty;
      const applicability = applicabilityResult.rows[0];

      const versionResult = await client.query("SELECT source_version, source_url FROM compliance.isl_version WHERE id = $1", [occupation.isl_version_id]);

      return {
        found: true,
        isListed: applicability.is_listed,
        jurisdiction: jurisdictionName,
        occupationCriteria: occupation.occupation_criteria,
        jurisdictionCriteria: applicability.jurisdiction_criteria,
        removalDate: occupation.removal_date ? String(occupation.removal_date).slice(0, 10) : null,
        sourceVersion: versionResult.rows[0]?.source_version ?? null,
        sourceUrl: versionResult.rows[0]?.source_url ?? null,
      };
    });
  }

  // --- Supporting Evidence (Document Upload & Storage) ---

  private static rowToDocumentDto(r: any): SupportingDocumentDto {
    return {
      id: r.id,
      employeeId: r.employee_id,
      documentType: r.document_type,
      description: r.description,
      originalFilename: r.original_filename,
      contentType: r.content_type,
      sizeBytes: Number(r.size_bytes),
      status: r.status,
      uploadedBy: r.uploaded_by,
      uploadedAt: r.uploaded_at,
      createdAt: r.created_at,
    };
  }

  async requestDocumentUpload(tenantId: string, employeeId: string, userId: string | undefined, dto: RequestUploadDto): Promise<RequestUploadResponseDto> {
    if (!ALLOWED_CONTENT_TYPES.has(dto.contentType)) {
      throw new BadRequestException(`File type "${dto.contentType}" isn't allowed. Allowed types: PDF, JPG, PNG, DOCX.`);
    }
    if (dto.sizeBytes > MAX_UPLOAD_BYTES) {
      throw new BadRequestException(`File is too large - the limit is ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.`);
    }
    if (!dto.documentType?.trim()) throw new BadRequestException("Document type is required.");

    return withTenant(tenantId, async (client) => {
      const employeeExists = await client.query(
        "SELECT 1 FROM employee.employee_master WHERE id = $1 AND NOT is_deleted",
        [employeeId]
      );
      if (!employeeExists.rowCount) throw new NotFoundException("Candidate not found.");

      const uuid = randomUUID();
      const storageKey = buildStorageKey(tenantId, employeeId, uuid, dto.filename);

      const result = await client.query(
        `INSERT INTO compliance.supporting_document
          (tenant_id, employee_id, document_type, description, original_filename, storage_key, content_type, size_bytes, status, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Pending',$9)
         RETURNING id`,
        [tenantId, employeeId, dto.documentType.trim(), dto.description || null, dto.filename, storageKey, dto.contentType, dto.sizeBytes, userId || null]
      );

      const uploadUrl = await getSignedUploadUrl(storageKey, dto.contentType);
      return { documentId: result.rows[0].id, uploadUrl };
    });
  }

  /** Confirms the client's direct-to-GCS upload actually landed,
   * verifying against the object itself rather than trusting the
   * frontend's say-so - flips Pending to Uploaded, or Failed if the
   * object never showed up. */
  async confirmDocumentUpload(tenantId: string, documentId: string, requesterEmployeeId?: string): Promise<SupportingDocumentDto> {
    return withTenant(tenantId, async (client) => {
      const docResult = await client.query(
        "SELECT * FROM compliance.supporting_document WHERE id = $1 AND deleted_at IS NULL",
        [documentId]
      );
      if (!docResult.rowCount) throw new NotFoundException("Document not found.");
      const doc = docResult.rows[0];
      if (requesterEmployeeId && doc.employee_id !== requesterEmployeeId) {
        throw new ForbiddenException("You can only manage your own documents.");
      }

      const verified = await verifyUploadedObject(doc.storage_key);
      if (!verified.exists) {
        await client.query("UPDATE compliance.supporting_document SET status = 'Failed' WHERE id = $1", [documentId]);
        throw new BadRequestException("The upload didn't complete - the file wasn't found in storage.");
      }

      const result = await client.query(
        `UPDATE compliance.supporting_document
         SET status = 'Uploaded', uploaded_at = now(), size_bytes = $1, checksum_md5 = $2
         WHERE id = $3 RETURNING *`,
        [verified.sizeBytes, verified.md5Hash, documentId]
      );
      return ComplianceService.rowToDocumentDto(result.rows[0]);
    });
  }

  async listDocuments(tenantId: string, employeeId: string): Promise<SupportingDocumentDto[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM compliance.supporting_document
         WHERE employee_id = $1 AND deleted_at IS NULL AND status != 'Failed'
         ORDER BY created_at DESC`,
        [employeeId]
      );
      return result.rows.map(ComplianceService.rowToDocumentDto);
    });
  }

  async getDocumentDownloadUrl(tenantId: string, documentId: string, requesterEmployeeId?: string): Promise<{ url: string; filename: string }> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        "SELECT employee_id, storage_key, original_filename FROM compliance.supporting_document WHERE id = $1 AND deleted_at IS NULL AND status = 'Uploaded'",
        [documentId]
      );
      if (!result.rowCount) throw new NotFoundException("Document not found.");
      if (requesterEmployeeId && result.rows[0].employee_id !== requesterEmployeeId) {
        throw new ForbiddenException("You can only download your own documents.");
      }
      const url = await getSignedDownloadUrl(result.rows[0].storage_key);
      return { url, filename: result.rows[0].original_filename };
    });
  }

  async softDeleteDocument(tenantId: string, documentId: string, requesterEmployeeId?: string): Promise<{ id: string }> {
    return withTenant(tenantId, async (client) => {
      if (requesterEmployeeId) {
        const owner = await client.query(
          "SELECT employee_id FROM compliance.supporting_document WHERE id = $1 AND deleted_at IS NULL",
          [documentId]
        );
        if (!owner.rowCount) throw new NotFoundException("Document not found.");
        if (owner.rows[0].employee_id !== requesterEmployeeId) {
          throw new ForbiddenException("You can only delete your own documents.");
        }
      }
      const result = await client.query(
        "UPDATE compliance.supporting_document SET status = 'Deleted', deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id",
        [documentId]
      );
      if (!result.rowCount) throw new NotFoundException("Document not found.");
      return { id: result.rows[0].id };
    });
  }

  // --- Sponsorship Assessment (Pre-Employment Compliance Check) ---

  async listSponsorshipAssessments(tenantId: string, employeeId: string): Promise<SponsorshipAssessmentDto[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM compliance.sponsorship_assessment WHERE employee_id = $1 ORDER BY assessed_at DESC`,
        [employeeId]
      );
      return result.rows.map((r: any) => ({
        id: r.id,
        employeeId: r.employee_id,
        socCode: r.soc_code,
        socTitle: r.soc_title,
        status: r.status,
        sourceTable: r.source_table,
        goingRate: r.going_rate != null ? Number(r.going_rate) : null,
        notes: r.notes ?? "",
        assessedBy: r.assessed_by,
        assessedAt: r.assessed_at,
        proposedRoute: r.proposed_route,
        checks: r.checks_json,
        overallResult: r.overall_result,
        decision: r.decision,
        reviewer: r.reviewer,
        assessmentDate: toDateStr(r.assessment_date),
        remarks: r.remarks,
        islListed: r.isl_listed,
        islJurisdiction: r.isl_jurisdiction,
        islCriteria: r.isl_criteria,
        islRemovalDate: toDateStr(r.isl_removal_date),
        islSourceVersion: r.isl_source_version,
      }));
    });
  }

  /** Records a snapshot - deliberately append-only (no update/delete
   * granted on this table, see migration 014's comment) so a past
   * assessment always shows what was actually seen at the time, even
   * if the underlying Skilled Worker rule changes later. */
  async createSponsorshipAssessment(tenantId: string, employeeId: string, userId: string | undefined, dto: CreateSponsorshipAssessmentDto): Promise<SponsorshipAssessmentDto> {
    return withTenant(tenantId, async (client) => {
      const employeeExists = await client.query(
        "SELECT 1 FROM employee.employee_master WHERE id = $1 AND NOT is_deleted",
        [employeeId]
      );
      if (!employeeExists.rowCount) throw new NotFoundException("Candidate not found.");

      const result = await client.query(
        `INSERT INTO compliance.sponsorship_assessment
          (tenant_id, employee_id, soc_code, soc_title, status, source_table, going_rate, notes, assessed_by,
           proposed_route, checks_json, overall_result, decision, reviewer, assessment_date, remarks,
           isl_listed, isl_jurisdiction, isl_criteria, isl_removal_date, isl_source_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING *`,
        [
          tenantId, employeeId, dto.socCode || null, dto.socTitle || null, dto.status || null,
          dto.sourceTable || null, dto.goingRate ?? null, dto.notes || null, userId || null,
          dto.proposedRoute || "Skilled Worker", dto.checks ? JSON.stringify(dto.checks) : null,
          dto.overallResult || null, dto.decision || null, dto.reviewer || null, dto.assessmentDate || null,
          dto.remarks || null, dto.islListed ?? null, dto.islJurisdiction || null, dto.islCriteria || null,
          dto.islRemovalDate || null, dto.islSourceVersion || null,
        ]
      );
      const r = result.rows[0];
      return {
        id: r.id,
        employeeId: r.employee_id,
        socCode: r.soc_code,
        socTitle: r.soc_title,
        status: r.status,
        sourceTable: r.source_table,
        goingRate: r.going_rate != null ? Number(r.going_rate) : null,
        notes: r.notes ?? "",
        assessedBy: r.assessed_by,
        assessedAt: r.assessed_at,
        proposedRoute: r.proposed_route,
        checks: r.checks_json,
        overallResult: r.overall_result,
        decision: r.decision,
        reviewer: r.reviewer,
        assessmentDate: toDateStr(r.assessment_date),
        remarks: r.remarks,
        islListed: r.isl_listed,
        islJurisdiction: r.isl_jurisdiction,
        islCriteria: r.isl_criteria,
        islRemovalDate: toDateStr(r.isl_removal_date),
        islSourceVersion: r.isl_source_version,
      };
    });
  }
}
