import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { withTenant } from "../db";
import type {
  SimpleReferenceKind,
  SimpleReferenceItemDto,
  HolidayDto,
  EmployerProfileDto,
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
    companyName: "", tradingName: "", registeredAddress: "", companiesHouseNumber: "",
    sponsorLicenceNumber: "", payeReference: "", accountsOfficeReference: "",
    primaryContactName: "", primaryContactEmail: "", primaryContactPhone: "",
  };
}

function rowToEmployerProfile(r: any): EmployerProfileDto {
  return {
    companyName: r.company_name ?? "",
    tradingName: r.trading_name ?? "",
    registeredAddress: r.registered_address ?? "",
    companiesHouseNumber: r.companies_house_number ?? "",
    sponsorLicenceNumber: r.sponsor_licence_number ?? "",
    payeReference: r.paye_reference ?? "",
    accountsOfficeReference: r.accounts_office_reference ?? "",
    primaryContactName: r.primary_contact_name ?? "",
    primaryContactEmail: r.primary_contact_email ?? "",
    primaryContactPhone: r.primary_contact_phone ?? "",
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
      if (dto.tradingName !== undefined) set("trading_name", dto.tradingName || null);
      if (dto.registeredAddress !== undefined) set("registered_address", dto.registeredAddress || null);
      if (dto.companiesHouseNumber !== undefined) set("companies_house_number", dto.companiesHouseNumber || null);
      if (dto.sponsorLicenceNumber !== undefined) set("sponsor_licence_number", dto.sponsorLicenceNumber || null);
      if (dto.payeReference !== undefined) set("paye_reference", dto.payeReference || null);
      if (dto.accountsOfficeReference !== undefined) set("accounts_office_reference", dto.accountsOfficeReference || null);
      if (dto.primaryContactName !== undefined) set("primary_contact_name", dto.primaryContactName || null);
      if (dto.primaryContactEmail !== undefined) set("primary_contact_email", dto.primaryContactEmail || null);
      if (dto.primaryContactPhone !== undefined) set("primary_contact_phone", dto.primaryContactPhone || null);
      set("updated_at", new Date());

      values.push(tenantId);
      const result = await client.query(
        `UPDATE reference.employer_profile SET ${sets.join(", ")} WHERE tenant_id = $${i} RETURNING *`,
        values
      );
      return rowToEmployerProfile(result.rows[0]);
    });
  }
}
