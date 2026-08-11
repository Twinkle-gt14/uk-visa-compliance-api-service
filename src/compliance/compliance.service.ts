import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import * as XLSX from "xlsx";
import { withTenant } from "../db";
import { parseAppendixTable, parseHealthcarePayBands, parseEducationPayScales } from "./appendix-parser";
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
  { sheet: "Table_1a", sourceTable: "Table 1a", status: "Transitional" },
  { sheet: "Table_2", sourceTable: "Table 2", status: "Eligible" },
  { sheet: "Table_2aa", sourceTable: "Table 2aa", status: "Transitional" },
  { sheet: "Table_2a", sourceTable: "Table 2a", status: "Transitional" },
  { sheet: "Table_2b", sourceTable: "Table 2b", status: "Not Eligible" },
  { sheet: "Table_3", sourceTable: "Table 3", status: "Eligible" },
  { sheet: "Table_3a", sourceTable: "Table 3a", status: "Transitional" },
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

      const listSql = `
        SELECT m.soc_code, m.soc_title, m.major_group, m.sub_major_group, m.minor_group,
               sw.status, sw.source_table, sw.going_rate, sw.going_rate_90, sw.going_rate_80,
               sw.going_rate_70, sw.effective_from
        FROM reference.soc_occupation_master m
        LEFT JOIN compliance.skilled_worker_occupation_master sw
          ON sw.tenant_id = m.tenant_id AND sw.soc_code = m.soc_code AND sw.effective_to IS NULL
        ${whereSql}
        ORDER BY m.soc_code
        LIMIT $${i} OFFSET $${i + 1}
      `;
      values.push(pageSize, offset);

      const countSql = `
        SELECT count(*)::int AS n
        FROM reference.soc_occupation_master m
        LEFT JOIN compliance.skilled_worker_occupation_master sw
          ON sw.tenant_id = m.tenant_id AND sw.soc_code = m.soc_code AND sw.effective_to IS NULL
        ${whereSql}
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

  private async computeSummary(client: any): Promise<SkilledWorkerSummaryCountsDto> {
    const result = await client.query(`
      SELECT
        count(*)::int AS total,
        count(sw.id) FILTER (WHERE sw.id IS NOT NULL)::int AS mapped,
        count(*) FILTER (WHERE sw.id IS NULL)::int AS not_mapped,
        count(*) FILTER (WHERE sw.status = 'Eligible')::int AS eligible,
        count(*) FILTER (WHERE sw.status = 'Not Eligible')::int AS not_eligible,
        count(*) FILTER (WHERE sw.status IN ('Conditional', 'Transitional'))::int AS conditional_or_transitional
      FROM reference.soc_occupation_master m
      LEFT JOIN compliance.skilled_worker_occupation_master sw
        ON sw.tenant_id = m.tenant_id AND sw.soc_code = m.soc_code AND sw.effective_to IS NULL
    `);
    const r = result.rows[0];
    return {
      totalSocOccupations: r.total,
      mapped: r.mapped,
      notMapped: r.not_mapped,
      eligible: r.eligible,
      notEligible: r.not_eligible,
      conditionalOrTransitional: r.conditional_or_transitional,
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

      return this.getImportBatch(tenantId, batch.id);
    });
  }

  async getImportBatch(tenantId: string, batchId: string): Promise<ImportBatchDto> {
    return withTenant(tenantId, async (client) => {
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
    });
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

      return this.getImportBatch(tenantId, batchId);
    });
  }

  async cancelImport(tenantId: string, batchId: string): Promise<ImportBatchDto> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE compliance.import_batch SET status = 'Cancelled', reviewed_at = now() WHERE id = $1 AND status = 'Pending Review' RETURNING id`,
        [batchId]
      );
      if (!result.rowCount) throw new NotFoundException("Import batch not found or already reviewed.");
      return this.getImportBatch(tenantId, batchId);
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
}
