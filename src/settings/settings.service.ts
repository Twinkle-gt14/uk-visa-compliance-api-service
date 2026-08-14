import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import * as XLSX from "xlsx";
import { withTenant } from "../db";
import type {
  SimpleReferenceKind,
  SimpleReferenceItemDto,
  HolidayDto,
  EmployerProfileDto,
  SponsorshipProfileDto,
  Soc2020CodeDto,
  JurisdictionDto,
  WorkLocationDto,
} from "./settings.dto";

/** Maps each kind to its real table name via a fixed whitelist (not
 * user input), so this stays safe to interpolate into SQL despite
 * `pg` having no way to parameterize an identifier. All four tables
 * share the exact same (tenant_id, id, name) shape, which is what
 * makes one generic implementation correct here rather than four
 * near-identical copies. */
const TABLE_BY_KIND: Record<SimpleReferenceKind, string> = {
  department: "reference.department",
  position: "reference.position",
  visa_type: "reference.visa_type",
  work_location: "reference.work_location",
};

function emptyEmployerProfile(): EmployerProfileDto {
  return {
    companyName: "", addressLine1: "", addressLine2: "", city: "", county: "", postcode: "", country: "",
    primaryContactName: "", primaryContactEmail: "", primaryContactPhone: "", emailDomain: "",
  };
}

function rowToEmployerProfile(r: any): EmployerProfileDto {
  return {
    companyName: r.company_name ?? "",
    addressLine1: r.address_line1 ?? "",
    addressLine2: r.address_line2 ?? "",
    city: r.city ?? "",
    county: r.county ?? "",
    postcode: r.postcode ?? "",
    country: r.country ?? "",
    primaryContactName: r.primary_contact_name ?? "",
    primaryContactEmail: r.primary_contact_email ?? "",
    primaryContactPhone: r.primary_contact_phone ?? "",
    emailDomain: r.email_domain ?? "",
  };
}

function emptySponsorshipProfile(): SponsorshipProfileDto {
  return { companyName: "", sponsorLicenceNumber: "", sponsorName: "" };
}

function rowToSponsorshipProfile(r: any): SponsorshipProfileDto {
  return {
    companyName: r.company_name ?? "",
    sponsorLicenceNumber: r.sponsor_licence_number ?? "",
    sponsorName: r.sponsor_name ?? "",
  };
}

@Injectable()
export class SettingsService {
  async listSimple(tenantId: string, kind: SimpleReferenceKind): Promise<SimpleReferenceItemDto[]> {
    const table = TABLE_BY_KIND[kind];
    return withTenant(tenantId, async (client) => {
      const result = await client.query(`SELECT id, name FROM ${table} ORDER BY name`);
      return result.rows;
    });
  }

  async createSimple(tenantId: string, kind: SimpleReferenceKind, name: string): Promise<SimpleReferenceItemDto> {
    if (!name?.trim()) throw new BadRequestException("Name is required.");
    const table = TABLE_BY_KIND[kind];
    return withTenant(tenantId, async (client) => {
      try {
        const result = await client.query(
          `INSERT INTO ${table} (tenant_id, name) VALUES ($1, $2) RETURNING id, name`,
          [tenantId, name.trim()]
        );
        return result.rows[0];
      } catch (err: any) {
        if (err?.code === "23505") throw new ConflictException(`"${name.trim()}" already exists.`);
        throw err;
      }
    });
  }

  async updateSimple(tenantId: string, kind: SimpleReferenceKind, id: string, name: string): Promise<SimpleReferenceItemDto> {
    if (!name?.trim()) throw new BadRequestException("Name is required.");
    const table = TABLE_BY_KIND[kind];
    return withTenant(tenantId, async (client) => {
      try {
        const result = await client.query(
          `UPDATE ${table} SET name = $1 WHERE id = $2 RETURNING id, name`,
          [name.trim(), id]
        );
        if (!result.rowCount) throw new NotFoundException("Not found.");
        return result.rows[0];
      } catch (err: any) {
        if (err?.code === "23505") throw new ConflictException(`"${name.trim()}" already exists.`);
        throw err;
      }
    });
  }

  // --- UK Jurisdiction Master (seed-on-first-read, same pattern as
  // reference.leave_type / reference.payslip_component) ---
  private static readonly SEED_JURISDICTIONS = [
    { code: "england", name: "England" },
    { code: "scotland", name: "Scotland" },
    { code: "wales", name: "Wales" },
    { code: "northern_ireland", name: "Northern Ireland" },
  ];

  async listJurisdictions(tenantId: string): Promise<JurisdictionDto[]> {
    return withTenant(tenantId, async (client) => {
      const existing = await client.query(
        "SELECT id, code, name FROM reference.uk_jurisdiction WHERE is_active ORDER BY name"
      );
      if (existing.rowCount) return existing.rows;

      for (const j of SettingsService.SEED_JURISDICTIONS) {
        await client.query(
          "INSERT INTO reference.uk_jurisdiction (tenant_id, code, name) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, code) DO NOTHING",
          [tenantId, j.code, j.name]
        );
      }
      const seeded = await client.query(
        "SELECT id, code, name FROM reference.uk_jurisdiction WHERE is_active ORDER BY name"
      );
      return seeded.rows;
    });
  }

  // --- Work Location (dedicated, not the generic listSimple/createSimple/
  // updateSimple, since it carries a jurisdiction alongside its name) ---
  async listWorkLocations(tenantId: string): Promise<WorkLocationDto[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT w.id, w.name, w.jurisdiction_id, j.name AS jurisdiction_name
         FROM reference.work_location w
         LEFT JOIN reference.uk_jurisdiction j ON j.id = w.jurisdiction_id
         ORDER BY w.name`
      );
      return result.rows.map((r: any) => ({
        id: r.id, name: r.name, jurisdictionId: r.jurisdiction_id, jurisdictionName: r.jurisdiction_name,
      }));
    });
  }

  async createWorkLocation(tenantId: string, name: string, jurisdictionId?: string | null): Promise<WorkLocationDto> {
    if (!name?.trim()) throw new BadRequestException("Name is required.");
    return withTenant(tenantId, async (client) => {
      try {
        const result = await client.query(
          `INSERT INTO reference.work_location (tenant_id, name, jurisdiction_id) VALUES ($1,$2,$3) RETURNING id, name, jurisdiction_id`,
          [tenantId, name.trim(), jurisdictionId || null]
        );
        const r = result.rows[0];
        let jurisdictionName: string | null = null;
        if (r.jurisdiction_id) {
          const j = await client.query("SELECT name FROM reference.uk_jurisdiction WHERE id = $1", [r.jurisdiction_id]);
          jurisdictionName = j.rows[0]?.name ?? null;
        }
        return { id: r.id, name: r.name, jurisdictionId: r.jurisdiction_id, jurisdictionName };
      } catch (err: any) {
        if (err?.code === "23505") throw new ConflictException(`"${name.trim()}" already exists.`);
        throw err;
      }
    });
  }

  async updateWorkLocation(tenantId: string, id: string, name: string, jurisdictionId?: string | null): Promise<WorkLocationDto> {
    if (!name?.trim()) throw new BadRequestException("Name is required.");
    return withTenant(tenantId, async (client) => {
      try {
        const result = await client.query(
          `UPDATE reference.work_location SET name = $1, jurisdiction_id = $2 WHERE id = $3 RETURNING id, name, jurisdiction_id`,
          [name.trim(), jurisdictionId || null, id]
        );
        if (!result.rowCount) throw new NotFoundException("Not found.");
        const r = result.rows[0];
        let jurisdictionName: string | null = null;
        if (r.jurisdiction_id) {
          const j = await client.query("SELECT name FROM reference.uk_jurisdiction WHERE id = $1", [r.jurisdiction_id]);
          jurisdictionName = j.rows[0]?.name ?? null;
        }
        return { id: r.id, name: r.name, jurisdictionId: r.jurisdiction_id, jurisdictionName };
      } catch (err: any) {
        if (err?.code === "23505") throw new ConflictException(`"${name.trim()}" already exists.`);
        throw err;
      }
    });
  }

  /** A FK violation here means something still references this row
   * (e.g. an employee assigned to this department) - a clean 409
   * explaining that, rather than a raw 500. */
  async deleteSimple(tenantId: string, kind: SimpleReferenceKind, id: string): Promise<{ id: string }> {
    const table = TABLE_BY_KIND[kind];
    const label = kind.replace("_", " ");
    return withTenant(tenantId, async (client) => {
      try {
        const result = await client.query(`DELETE FROM ${table} WHERE id = $1 RETURNING id`, [id]);
        if (!result.rowCount) throw new NotFoundException("Not found.");
        return result.rows[0];
      } catch (err: any) {
        if (err?.code === "23503") {
          throw new ConflictException(`This ${label} is still assigned to one or more employees and can't be deleted.`);
        }
        throw err;
      }
    });
  }

  async listHolidays(tenantId: string): Promise<HolidayDto[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query("SELECT id, holiday_date, name FROM reference.holiday ORDER BY holiday_date");
      return result.rows.map((r) => ({ id: r.id, date: r.holiday_date.toISOString().slice(0, 10), name: r.name }));
    });
  }

  async createHoliday(tenantId: string, date: string, name: string): Promise<HolidayDto> {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException(`Invalid date: "${date}"`);
    if (!name?.trim()) throw new BadRequestException("Name is required.");
    return withTenant(tenantId, async (client) => {
      try {
        const result = await client.query(
          "INSERT INTO reference.holiday (tenant_id, holiday_date, name) VALUES ($1, $2, $3) RETURNING id, holiday_date, name",
          [tenantId, date, name.trim()]
        );
        return { id: result.rows[0].id, date: result.rows[0].holiday_date.toISOString().slice(0, 10), name: result.rows[0].name };
      } catch (err: any) {
        if (err?.code === "23505") throw new ConflictException(`A holiday is already recorded on ${date}.`);
        throw err;
      }
    });
  }

  async updateHoliday(tenantId: string, id: string, date?: string, name?: string): Promise<HolidayDto> {
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException(`Invalid date: "${date}"`);
    if (name !== undefined && !name.trim()) throw new BadRequestException("Name is required.");
    return withTenant(tenantId, async (client) => {
      const sets: string[] = [];
      const values: any[] = [];
      let i = 1;
      if (date !== undefined) { sets.push(`holiday_date = $${i++}`); values.push(date); }
      if (name !== undefined) { sets.push(`name = $${i++}`); values.push(name.trim()); }
      if (!sets.length) throw new BadRequestException("Nothing to update.");
      values.push(id);
      try {
        const result = await client.query(
          `UPDATE reference.holiday SET ${sets.join(", ")} WHERE id = $${i} RETURNING id, holiday_date, name`,
          values
        );
        if (!result.rowCount) throw new NotFoundException("Holiday not found.");
        return { id: result.rows[0].id, date: result.rows[0].holiday_date.toISOString().slice(0, 10), name: result.rows[0].name };
      } catch (err: any) {
        if (err?.code === "23505") throw new ConflictException(`A holiday is already recorded on ${date}.`);
        throw err;
      }
    });
  }

  async deleteHoliday(tenantId: string, id: string): Promise<{ id: string }> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query("DELETE FROM reference.holiday WHERE id = $1 RETURNING id", [id]);
      if (!result.rowCount) throw new NotFoundException("Holiday not found.");
      return result.rows[0];
    });
  }

  /** Singleton per tenant - reads return an empty-but-shaped profile
   * rather than 404 when nothing's been saved yet, so the frontend
   * form always has something sensible to render. */
  async getEmployerProfile(tenantId: string): Promise<EmployerProfileDto> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query("SELECT * FROM reference.employer_profile WHERE tenant_id = $1", [tenantId]);
      return result.rowCount ? rowToEmployerProfile(result.rows[0]) : emptyEmployerProfile();
    });
  }

  async updateEmployerProfile(tenantId: string, dto: Partial<EmployerProfileDto>): Promise<EmployerProfileDto> {
    return withTenant(tenantId, async (client) => {
      // Guarantee a row exists first (no-op if one already does) - lets
      // the UPDATE below be a genuine partial update, only touching
      // fields the caller actually provided, rather than overwriting
      // every column (which previously wiped out anything not included
      // in a given PATCH request).
      await client.query(
        "INSERT INTO reference.employer_profile (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING",
        [tenantId]
      );

      const sets: string[] = [];
      const values: any[] = [];
      let i = 1;
      const set = (col: string, val: any) => { sets.push(`${col} = $${i++}`); values.push(val); };

      if (dto.companyName !== undefined) set("company_name", dto.companyName || null);
      if (dto.addressLine1 !== undefined) set("address_line1", dto.addressLine1 || null);
      if (dto.addressLine2 !== undefined) set("address_line2", dto.addressLine2 || null);
      if (dto.city !== undefined) set("city", dto.city || null);
      if (dto.county !== undefined) set("county", dto.county || null);
      if (dto.postcode !== undefined) set("postcode", dto.postcode || null);
      if (dto.country !== undefined) set("country", dto.country || null);
      if (dto.primaryContactName !== undefined) set("primary_contact_name", dto.primaryContactName || null);
      if (dto.primaryContactEmail !== undefined) set("primary_contact_email", dto.primaryContactEmail || null);
      if (dto.primaryContactPhone !== undefined) set("primary_contact_phone", dto.primaryContactPhone || null);
      if (dto.emailDomain !== undefined) set("email_domain", dto.emailDomain?.trim().toLowerCase() || null);
      set("updated_at", new Date());

      values.push(tenantId);
      const result = await client.query(
        `UPDATE reference.employer_profile SET ${sets.join(", ")} WHERE tenant_id = $${i} RETURNING *`,
        values
      );
      return rowToEmployerProfile(result.rows[0]);
    });
  }

  /** Sponsorship (Settings > Sponsorship) reads/writes the same
   * reference.employer_profile row as Employer - just a different
   * field subset, since both are genuinely one-per-tenant facts. */
  async getSponsorshipProfile(tenantId: string): Promise<SponsorshipProfileDto> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query("SELECT * FROM reference.employer_profile WHERE tenant_id = $1", [tenantId]);
      return result.rowCount ? rowToSponsorshipProfile(result.rows[0]) : emptySponsorshipProfile();
    });
  }

  async updateSponsorshipProfile(tenantId: string, dto: Partial<SponsorshipProfileDto>): Promise<SponsorshipProfileDto> {
    return withTenant(tenantId, async (client) => {
      await client.query(
        "INSERT INTO reference.employer_profile (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING",
        [tenantId]
      );

      const sets: string[] = [];
      const values: any[] = [];
      let i = 1;
      const set = (col: string, val: any) => { sets.push(`${col} = $${i++}`); values.push(val); };

      if (dto.sponsorLicenceNumber !== undefined) set("sponsor_licence_number", dto.sponsorLicenceNumber || null);
      if (dto.sponsorName !== undefined) set("sponsor_name", dto.sponsorName || null);
      set("updated_at", new Date());

      values.push(tenantId);
      const result = await client.query(
        `UPDATE reference.employer_profile SET ${sets.join(", ")} WHERE tenant_id = $${i} RETURNING *`,
        values
      );
      return rowToSponsorshipProfile(result.rows[0]);
    });
  }

  // --- SOC2020 Framework ---

  async listSoc2020(tenantId: string): Promise<Soc2020CodeDto[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, soc_code, soc_title, major_group, major_group_title, sub_major_group, sub_major_group_title,
                minor_group, minor_group_title, change_note, verno
         FROM reference.soc_occupation_master
         ORDER BY soc_code`
      );
      return result.rows.map((r) => ({
        id: r.id,
        socCode: r.soc_code ?? "",
        socTitle: r.soc_title ?? "",
        majorGroup: r.major_group ?? "",
        majorGroupTitle: r.major_group_title ?? "",
        subMajorGroup: r.sub_major_group ?? "",
        subMajorGroupTitle: r.sub_major_group_title ?? "",
        minorGroup: r.minor_group ?? "",
        minorGroupTitle: r.minor_group_title ?? "",
        changeNote: r.change_note ?? "",
        verno: r.verno ?? "",
      }));
    });
  }

  /** Parses the ONS SOC2020 master Excel file and upserts every row
   * keyed on soc_unit_group (the 4-digit code - the selectable level
   * per the file's own README sheet), so re-uploading a corrected file
   * updates existing rows rather than duplicating them. Scans every
   * sheet in the workbook for one whose header row looks like the
   * expected columns, rather than assuming sheet order/position,
   * since a "README" or notes sheet is often included alongside the
   * data sheet (as it is in the reference file this was built against). */
  async uploadSoc2020(tenantId: string, fileBuffer: Buffer): Promise<{ imported: number }> {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(fileBuffer, { type: "buffer" });
    } catch {
      throw new BadRequestException("Couldn't read that file - is it a valid .xlsx spreadsheet?");
    }

    const REQUIRED_COLUMNS = ["soc_unit_group", "soc_group_title"];
    let rows: Record<string, any>[] | null = null;
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const candidate = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: null });
      if (candidate.length && REQUIRED_COLUMNS.every((col) => col in candidate[0])) {
        rows = candidate;
        break;
      }
    }
    if (!rows) {
      throw new BadRequestException(
        `Couldn't find a sheet with the expected SOC2020 columns (${REQUIRED_COLUMNS.join(", ")}).`
      );
    }

    // Source file's own column names (soc_unit_group / soc_group_title)
    // are kept as-is here since that's what's actually in the .xlsx -
    // they're mapped onto this app's soc_code / soc_title naming below.
    const validRows = rows.filter((r) => r.soc_unit_group != null && String(r.soc_unit_group).trim() !== "");
    if (!validRows.length) {
      throw new BadRequestException("No rows with a SOC Unit Group code were found in that file.");
    }

    return withTenant(tenantId, async (client) => {
      for (const r of validRows) {
        await client.query(
          `INSERT INTO reference.soc_occupation_master
            (tenant_id, major_group, major_group_title, sub_major_group, sub_major_group_title,
             minor_group, minor_group_title, soc_code, soc_title, change_note, verno)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (tenant_id, soc_code) DO UPDATE SET
             major_group = EXCLUDED.major_group, major_group_title = EXCLUDED.major_group_title,
             sub_major_group = EXCLUDED.sub_major_group, sub_major_group_title = EXCLUDED.sub_major_group_title,
             minor_group = EXCLUDED.minor_group, minor_group_title = EXCLUDED.minor_group_title,
             soc_title = EXCLUDED.soc_title, change_note = EXCLUDED.change_note,
             verno = EXCLUDED.verno, uploaded_at = now()`,
          [
            tenantId,
            r.major_group != null ? String(r.major_group) : null,
            r.major_group_title != null ? String(r.major_group_title) : null,
            r.sub_major_group != null ? String(r.sub_major_group) : null,
            r.sub_major_group_title != null ? String(r.sub_major_group_title) : null,
            r.minor_group != null ? String(r.minor_group) : null,
            r.minor_group_title != null ? String(r.minor_group_title) : null,
            String(r.soc_unit_group),
            r.soc_group_title != null ? String(r.soc_group_title) : null,
            r.change != null ? String(r.change) : null,
            r.verno != null ? String(r.verno) : null,
          ]
        );
      }
      return { imported: validRows.length };
    });
  }
}
