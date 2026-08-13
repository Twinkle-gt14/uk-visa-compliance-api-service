import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { withTenant } from "../db";
import type {
  EmployeeUpsertDto,
  EmployeeSummary,
  EmployeeStatus,
  EmailEntryDto,
  PhoneEntryDto,
  AddressEntryDto,
  EducationEntryDto,
  CertificationEntryDto,
  RtwCheckEntryDto,
  DocumentEntryDto,
} from "./employee.dto";

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "dev-only-change-me-encryption-key";

/** pgcrypto symmetric encrypt/decrypt for fields that must be
 * retrievable in full (NI number, bank details) - distinct from the
 * one-way bcrypt hashing AuthService uses for passwords. */
async function encrypt(client: PoolClient, value: string | undefined | null): Promise<Buffer | null> {
  if (!value) return null;
  const result = await client.query("SELECT pgp_sym_encrypt($1, $2) AS enc", [value, ENCRYPTION_KEY]);
  return result.rows[0].enc;
}
async function decrypt(client: PoolClient, value: Buffer | null): Promise<string | null> {
  if (!value) return null;
  const result = await client.query("SELECT pgp_sym_decrypt($1, $2) AS dec", [value, ENCRYPTION_KEY]);
  return result.rows[0].dec;
}

const HMAC_KEY = process.env.NI_HMAC_KEY || "dev-only-change-me-hmac-key";

/** Deterministic hash used only for the NI-number uniqueness check -
 * see the ni_number_hash column comment in the migration for why this
 * has to be separate from the (non-deterministic) encrypted value. */
async function hmacHash(client: PoolClient, value: string | undefined | null): Promise<string | null> {
  if (!value) return null;
  const result = await client.query("SELECT encode(hmac($1, $2, 'sha256'), 'hex') AS hash", [value, HMAC_KEY]);
  return result.rows[0].hash;
}

function genRef(): string {
  return `EMP-${Date.now().toString(36).toUpperCase()}`;
}

/** Postgres DATE columns come back from `pg` as JS Date objects, which
 * NestJS's default JSON serialization renders as full ISO timestamps
 * ("2026-01-01T00:00:00.000Z") - not the plain "YYYY-MM-DD" string
 * every <input type="date"> in the frontend wizard expects. Applied to
 * every date field read back from the database, not just the ones
 * caught by manual testing. */
function toDateStr(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/** Mirrors the mandatory fields the frontend itself enforces
 * (lib/employee-validation.ts) - the frontend's Review step doesn't
 * currently hard-block Save when something's missing elsewhere (a
 * known gap), so the API needs its own check too. Without this, a
 * missing required field surfaces as a raw Postgres type/constraint
 * error (a confusing 500) instead of a clear, actionable 400. */
function assertRequiredFields(dto: EmployeeUpsertDto): void {
  const missing: string[] = [];
  if (!dto.firstName?.trim()) missing.push("First name");
  if (!dto.lastName?.trim()) missing.push("Last name");
  if (!dto.dateOfBirth?.trim()) missing.push("Date of birth");
  if (!dto.jobTitle?.trim()) missing.push("Job title");
  if (!dto.department?.trim()) missing.push("Department");
  if (!dto.startDate?.trim()) missing.push("Start date");
  if (missing.length) {
    throw new BadRequestException(`Missing required field(s): ${missing.join(", ")}`);
  }
}

@Injectable()
export class EmployeeService {
  /** Looks up reference.department by name (trimmed, case-insensitive),
   * creating it if it doesn't exist yet. This remains a pragmatic
   * stand-in, not a real Reference Data module - normalizing the match
   * at least prevents "Engineering" and "engineering " from silently
   * becoming two different departments through typos. Proper
   * department management (rename, merge, delete) belongs to a
   * Settings/Reference Data API that doesn't exist yet. */
  private async resolveDepartmentId(client: PoolClient, tenantId: string, name: string): Promise<string> {
    const normalized = name.trim();
    const existing = await client.query(
      "SELECT id FROM reference.department WHERE tenant_id = $1 AND lower(name) = lower($2)",
      [tenantId, normalized]
    );
    if (existing.rowCount) return existing.rows[0].id;

    const created = await client.query(
      "INSERT INTO reference.department (tenant_id, name) VALUES ($1, $2) RETURNING id",
      [tenantId, normalized]
    );
    return created.rows[0].id;
  }

  async list(tenantId: string, page: number, pageSize: number): Promise<{ items: EmployeeSummary[]; total: number; page: number; pageSize: number }> {
    return withTenant(tenantId, async (client) => {
      const offset = (page - 1) * pageSize;
      const [rows, count] = await Promise.all([
        client.query(
          `SELECT m.id, m.employee_reference_no, m.first_name, m.middle_name, m.last_name,
                  m.job_title, m.record_status, m.start_date, m.current_location, m.photo_file_reference,
                  d.name AS department_name,
                  (SELECT value FROM employee.employee_contact_detail
                     WHERE employee_id = m.id AND contact_type = 'email' AND is_primary AND NOT is_removed LIMIT 1) AS primary_email,
                  (SELECT value FROM employee.employee_contact_detail
                     WHERE employee_id = m.id AND contact_type = 'phone' AND is_primary AND NOT is_removed LIMIT 1) AS primary_phone,
                  (SELECT row_to_json(a) FROM (
                     SELECT decision, assessment_date, reviewer
                     FROM compliance.sponsorship_assessment
                     WHERE employee_id = m.id ORDER BY assessed_at DESC LIMIT 1
                   ) a) AS latest_assessment,
                  (SELECT row_to_json(c) FROM (
                     SELECT licence_number, sponsor_name, certificate_number, assigned_date, expiry_date
                     FROM employee.employee_cos_detail WHERE employee_id = m.id
                   ) c) AS cos,
                  (SELECT row_to_json(v) FROM (
                     SELECT visa_type, visa_number, issue_date, expiry_date
                     FROM employee.employee_visa_detail WHERE employee_id = m.id
                   ) v) AS visa,
                  (SELECT row_to_json(r) FROM (
                     SELECT status, date_of_check, expiry_date
                     FROM employee.employee_rtw_check WHERE employee_id = m.id
                     ORDER BY date_of_check DESC NULLS LAST LIMIT 1
                   ) r) AS rtw
           FROM employee.employee_master m
           JOIN reference.department d ON d.id = m.department_id
           WHERE NOT m.is_deleted
           ORDER BY m.created_at DESC
           LIMIT $1 OFFSET $2`,
          [pageSize, offset]
        ),
        client.query("SELECT count(*)::int AS n FROM employee.employee_master WHERE NOT is_deleted"),
      ]);

      return {
        items: rows.rows.map((r) => ({
          id: r.id,
          employeeReferenceNo: r.employee_reference_no,
          fullName: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(" "),
          jobTitle: r.job_title,
          department: r.department_name,
          recordStatus: r.record_status,
          primaryEmail: r.primary_email ?? null,
          primaryPhone: r.primary_phone ?? null,
          currentLocation: r.current_location ?? null,
          startDate: r.start_date ?? null,
          photoFileName: r.photo_file_reference ?? null,
          complianceChecks: EmployeeService.buildComplianceChecks(r),
        })),
        total: count.rows[0].n,
        page,
        pageSize,
      };
    });
  }

  /** Derives each of the 4 Pre-Employment Compliance Check rows from
   * whatever's actually on file - no fabricated dates or reviewers.
   * "Completed" only fires once the record actually holds a real
   * decision/outcome, not just because a row exists (a half-filled
   * CoS/Visa record is still "In Progress"). */
  private static buildComplianceChecks(r: any): EmployeeSummary["complianceChecks"] {
    const assessment = r.latest_assessment;
    const cos = r.cos;
    const visa = r.visa;
    const rtw = r.rtw;

    const assessmentStatus = !assessment ? "Not Started" : assessment.decision ? "Completed" : "In Progress";
    const cosStatus =
      !cos || (!cos.licence_number && !cos.sponsor_name && !cos.certificate_number)
        ? "Not Started"
        : cos.certificate_number && cos.assigned_date && cos.expiry_date
        ? "Completed"
        : "In Progress";
    const visaStatus =
      !visa || (!visa.visa_type && !visa.visa_number)
        ? "Not Started"
        : visa.visa_type && visa.visa_number && visa.expiry_date
        ? "Completed"
        : "In Progress";
    const rtwStatus = !rtw ? "Not Started" : rtw.status === "Approved" ? "Completed" : "In Progress";

    return [
      {
        type: "assessment",
        status: assessmentStatus,
        nextCheckDate: r.start_date ?? null,
        lastUpdated: assessment?.assessment_date ?? null,
        updatedBy: assessment?.reviewer ?? null,
      },
      {
        type: "cos",
        status: cosStatus,
        nextCheckDate: cos?.expiry_date ?? null,
        lastUpdated: cos?.assigned_date ?? null,
        updatedBy: null,
      },
      {
        type: "visa",
        status: visaStatus,
        nextCheckDate: visa?.expiry_date ?? null,
        lastUpdated: visa?.issue_date ?? null,
        updatedBy: null,
      },
      {
        type: "rtw",
        status: rtwStatus,
        nextCheckDate: rtw?.expiry_date ?? null,
        lastUpdated: rtw?.date_of_check ?? null,
        updatedBy: null,
      },
    ];
  }

  async getById(tenantId: string, id: string): Promise<EmployeeUpsertDto & { id: string; recordStatus: EmployeeStatus }> {
    return withTenant(tenantId, async (client) => {
      const masterRes = await client.query(
        `SELECT m.*, d.name AS department_name
         FROM employee.employee_master m
         JOIN reference.department d ON d.id = m.department_id
         WHERE m.id = $1 AND NOT m.is_deleted`,
        [id]
      );
      if (!masterRes.rowCount) throw new NotFoundException("Employee not found.");
      const m = masterRes.rows[0];

      const [contacts, emergency, bank, quals, certs, passport, visa, cos, rtw, docs] = await Promise.all([
        client.query("SELECT * FROM employee.employee_contact_detail WHERE employee_id = $1 AND NOT is_removed", [id]),
        client.query("SELECT * FROM employee.employee_emergency_contact WHERE employee_id = $1 LIMIT 1", [id]),
        client.query("SELECT * FROM employee.employee_bank_detail WHERE employee_id = $1", [id]),
        client.query("SELECT * FROM employee.employee_qualification WHERE employee_id = $1", [id]),
        client.query("SELECT * FROM employee.employee_certification WHERE employee_id = $1", [id]),
        client.query("SELECT * FROM employee.employee_passport_detail WHERE employee_id = $1", [id]),
        client.query("SELECT * FROM employee.employee_visa_detail WHERE employee_id = $1", [id]),
        client.query("SELECT * FROM employee.employee_cos_detail WHERE employee_id = $1", [id]),
        client.query("SELECT * FROM employee.employee_rtw_check WHERE employee_id = $1", [id]),
        client.query("SELECT * FROM employee.employee_document WHERE employee_id = $1", [id]),
      ]);

      const ni = await decrypt(client, m.ni_number_encrypted);
      const b = bank.rows[0];
      const accountNumber = b ? await decrypt(client, b.account_number_encrypted) : null;
      const sortCode = b ? await decrypt(client, b.sort_code_encrypted) : null;
      const iban = b ? await decrypt(client, b.iban_encrypted) : null;
      const p = passport.rows[0];
      const v = visa.rows[0];
      const c = cos.rows[0];
      const e = emergency.rows[0];

      return {
        id: m.id,
        recordStatus: m.record_status,
        photoFileName: m.photo_file_reference,
        firstName: m.first_name,
        middleName: m.middle_name ?? "",
        lastName: m.last_name,
        dateOfBirth: toDateStr(m.date_of_birth),
        gender: m.gender ?? "",
        nationality: m.nationality ?? "",
        maritalStatus: m.marital_status ?? "",
        nationalInsuranceNumber: ni ?? "",

        emails: contacts.rows
          .filter((r) => r.contact_type === "email")
          .map((r): EmailEntryDto => ({ id: r.id, type: r.contact_subtype, email: r.value, isPrimary: r.is_primary })),
        phones: contacts.rows
          .filter((r) => r.contact_type === "phone")
          .map((r): PhoneEntryDto => ({ id: r.id, type: r.contact_subtype, number: r.value, isPrimary: r.is_primary })),
        addresses: contacts.rows
          .filter((r) => r.contact_type === "address")
          .map((r): AddressEntryDto => ({
            id: r.id, type: r.contact_subtype, line1: r.line1, line2: r.line2, city: r.city,
            county: r.county, postcode: r.postcode, country: r.country, isPrimary: r.is_primary,
          })),

        emergencyFullName: e?.full_name ?? "",
        emergencyRelationship: e?.relationship ?? "",
        emergencyPrimaryPhone: e?.primary_phone ?? "",
        emergencySecondaryPhone: e?.secondary_phone ?? "",
        emergencyAddress: e?.address ?? "",

        employeeId: m.employee_id_label ?? "",
        candidateId: m.candidate_id_label ?? "",
        jobTitle: m.job_title,
        department: m.department_name,
        projectWorkBranch: m.project_work_branch ?? "",
        reportingManager: m.reporting_manager_name ?? "",
        employmentType: m.employment_type ?? "",
        startDate: toDateStr(m.date_of_joining),
        workLocation: m.work_location ?? "",
        workTiming: m.work_timing ?? "",
        standardHoursPerWeek: m.standard_hours_per_week?.toString() ?? "",
        hourlyRate: m.hourly_rate?.toString() ?? "",
        socNumber: m.soc_number ?? "",
        jobDescription: m.job_description ?? "",
        contractDuration: m.contract_duration ?? "",
        currentLocation: m.current_location ?? "",
        currentImmigrationStatus: m.current_immigration_status ?? "",
        proposedAnnualSalary: m.proposed_annual_salary != null ? String(m.proposed_annual_salary) : "",
        jobContractFileName: m.job_contract_file_reference,
        sponsoredEmployee: m.sponsored_employee ? "Yes" : "No",
        britishEmployee: m.british_employee ? "Yes" : "No",

        accountHolderName: b?.account_holder_name ?? "",
        bankName: b?.bank_name ?? "",
        accountNumber: accountNumber ?? "",
        sortCode: sortCode ?? "",
        iban: iban ?? "",
        bankDocumentFileName: b?.document_file_reference ?? null,

        education: quals.rows.map((r): EducationEntryDto => ({
          id: r.id, institution: r.institution, qualification: r.qualification, fieldOfStudy: r.field_of_study,
          startDate: toDateStr(r.start_date), endDate: toDateStr(r.end_date), grade: r.grade, certificateFileName: r.certificate_file_reference,
        })),
        certifications: certs.rows.map((r): CertificationEntryDto => ({
          id: r.id, name: r.name, issuingBody: r.issuing_body, certificateNumber: r.certificate_number,
          issueDate: toDateStr(r.issue_date), expiryDate: toDateStr(r.expiry_date), fileName: r.file_reference,
        })),

        passportNumber: p?.passport_number ?? "",
        passportIssuingCountry: p?.issuing_country ?? "",
        passportIssueDate: toDateStr(p?.issue_date),
        passportExpiryDate: toDateStr(p?.expiry_date),
        passportFileName: p?.file_reference ?? null,

        visaType: v?.visa_type ?? "",
        visaNumber: v?.visa_number ?? "",
        visaIssueDate: toDateStr(v?.issue_date),
        visaExpiryDate: toDateStr(v?.expiry_date),
        visaConditions: v?.conditions
          ? v.conditions.replace(/^\{|\}$/g, "").split(",").map((s: string) => s.trim()).filter(Boolean)
          : [],
        visaFileName: v?.file_reference ?? null,

        cosLicenceNumber: c?.licence_number ?? "",
        cosSponsorName: c?.sponsor_name ?? "",
        cosCertificateNumber: c?.certificate_number ?? "",
        cosCertificateDate: toDateStr(c?.certificate_date),
        cosAssignedDate: toDateStr(c?.assigned_date),
        cosExpiryDate: toDateStr(c?.expiry_date),
        cosSponsorNote: c?.sponsor_note ?? "",
        cosFileName: c?.file_reference ?? null,

        rtwChecks: rtw.rows.map((r): RtwCheckEntryDto => ({
          id: r.id, shareCode: r.share_code, rtwReference: r.rtw_reference, dateOfCheck: toDateStr(r.date_of_check),
          status: r.status, expiryDate: toDateStr(r.expiry_date), attachmentFileName: r.attachment_file_reference,
        })),
        documents: docs.rows.map((r): DocumentEntryDto => ({
          id: r.id, fileName: r.file_reference, documentType: r.document_type,
          description: r.description, expiryDate: toDateStr(r.expiry_date),
        })),
      };
    });
  }

  async create(tenantId: string, dto: EmployeeUpsertDto, idempotencyKey?: string): Promise<{ id: string }> {
    assertRequiredFields(dto);

    return withTenant(tenantId, async (client) => {
      if (idempotencyKey) {
        const existing = await client.query(
          "SELECT employee_id FROM employee.idempotency_key WHERE tenant_id = $1 AND idempotency_key = $2",
          [tenantId, idempotencyKey]
        );
        if (existing.rowCount) {
          return { id: existing.rows[0].employee_id };
        }
      }

      const departmentId = await this.resolveDepartmentId(client, tenantId, dto.department);
      const niEncrypted = await encrypt(client, dto.nationalInsuranceNumber);
      const niHash = await hmacHash(client, dto.nationalInsuranceNumber);

      let masterId: string;
      try {
        const result = await client.query(
          `INSERT INTO employee.employee_master
            (tenant_id, employee_reference_no, first_name, middle_name, last_name, date_of_birth,
             gender, marital_status, nationality, ni_number_encrypted, ni_number_hash, job_title, department_id,
             employment_type, work_location, work_timing, standard_hours_per_week, soc_number,
             project_work_branch, sponsored_employee, british_employee, employee_id_label, candidate_id_label,
             job_contract_file_reference, date_of_joining, reporting_manager_name, photo_file_reference, hourly_rate,
             job_description, contract_duration, current_location, current_immigration_status, proposed_annual_salary)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
           RETURNING id`,
          [
            tenantId, genRef(), dto.firstName, dto.middleName || null, dto.lastName, dto.dateOfBirth || null,
            dto.gender || null, dto.maritalStatus || null, dto.nationality || null, niEncrypted, niHash,
            dto.jobTitle, departmentId, dto.employmentType || null, dto.workLocation || null,
            dto.workTiming || null, dto.standardHoursPerWeek ? Number(dto.standardHoursPerWeek) : null,
            dto.socNumber || null, dto.projectWorkBranch || null, dto.sponsoredEmployee === "Yes",
            dto.britishEmployee === "Yes", dto.employeeId || null, dto.candidateId || null, dto.jobContractFileName || null,
            dto.startDate || null, dto.reportingManager || null, dto.photoFileName || null,
            dto.hourlyRate ? Number(dto.hourlyRate) : null,
            dto.jobDescription || null, dto.contractDuration || null, dto.currentLocation || null, dto.currentImmigrationStatus || null,
            dto.proposedAnnualSalary ? Number(dto.proposedAnnualSalary) : null,
          ]
        );
        masterId = result.rows[0].id;
      } catch (err: any) {
        if (err?.constraint === "uq_employee_tenant_ni") {
          throw new ConflictException("A record with this National Insurance number already exists.");
        }
        throw err;
      }

      await this.writeChildRecords(client, tenantId, masterId, dto);

      if (idempotencyKey) {
        await client.query(
          "INSERT INTO employee.idempotency_key (tenant_id, idempotency_key, employee_id) VALUES ($1, $2, $3)",
          [tenantId, idempotencyKey, masterId]
        );
      }

      return { id: masterId };
    });
  }

  async update(tenantId: string, id: string, dto: Partial<EmployeeUpsertDto>): Promise<{ id: string }> {
    return withTenant(tenantId, async (client) => {
      const existing = await client.query(
        "SELECT id, record_status FROM employee.employee_master WHERE id = $1 AND NOT is_deleted",
        [id]
      );
      if (!existing.rowCount) throw new NotFoundException("Employee not found.");
      if (existing.rows[0].record_status !== "Active") {
        throw new BadRequestException(
          `This employee is ${existing.rows[0].record_status.toLowerCase()} and cannot be edited - reactivate the record first.`
        );
      }

      const sets: string[] = [];
      const values: any[] = [];
      let i = 1;
      const set = (col: string, val: any) => { sets.push(`${col} = $${i++}`); values.push(val); };

      if (dto.firstName !== undefined) set("first_name", dto.firstName);
      if (dto.middleName !== undefined) set("middle_name", dto.middleName || null);
      if (dto.lastName !== undefined) set("last_name", dto.lastName);
      if (dto.dateOfBirth !== undefined) {
        if (!dto.dateOfBirth.trim()) throw new BadRequestException("Date of birth cannot be cleared - it's a required field.");
        set("date_of_birth", dto.dateOfBirth);
      }
      if (dto.gender !== undefined) set("gender", dto.gender || null);
      if (dto.maritalStatus !== undefined) set("marital_status", dto.maritalStatus || null);
      if (dto.nationality !== undefined) set("nationality", dto.nationality || null);
      if (dto.nationalInsuranceNumber !== undefined) {
        set("ni_number_encrypted", await encrypt(client, dto.nationalInsuranceNumber));
        set("ni_number_hash", await hmacHash(client, dto.nationalInsuranceNumber));
      }
      if (dto.jobTitle !== undefined) set("job_title", dto.jobTitle);
      if (dto.department !== undefined) {
        if (!dto.department.trim()) throw new BadRequestException("Department cannot be cleared - it's a required field.");
        set("department_id", await this.resolveDepartmentId(client, tenantId, dto.department));
      }
      if (dto.employmentType !== undefined) set("employment_type", dto.employmentType || null);
      if (dto.workLocation !== undefined) set("work_location", dto.workLocation || null);
      if (dto.workTiming !== undefined) set("work_timing", dto.workTiming || null);
      if (dto.standardHoursPerWeek !== undefined) {
        set("standard_hours_per_week", dto.standardHoursPerWeek ? Number(dto.standardHoursPerWeek) : null);
      }
      if (dto.socNumber !== undefined) set("soc_number", dto.socNumber || null);
      if (dto.jobDescription !== undefined) set("job_description", dto.jobDescription || null);
      if (dto.contractDuration !== undefined) set("contract_duration", dto.contractDuration || null);
      if (dto.currentLocation !== undefined) set("current_location", dto.currentLocation || null);
      if (dto.currentImmigrationStatus !== undefined) set("current_immigration_status", dto.currentImmigrationStatus || null);
      if (dto.proposedAnnualSalary !== undefined) set("proposed_annual_salary", dto.proposedAnnualSalary ? Number(dto.proposedAnnualSalary) : null);
      if (dto.projectWorkBranch !== undefined) set("project_work_branch", dto.projectWorkBranch || null);
      if (dto.sponsoredEmployee !== undefined) set("sponsored_employee", dto.sponsoredEmployee === "Yes");
      if (dto.britishEmployee !== undefined) set("british_employee", dto.britishEmployee === "Yes");
      if (dto.employeeId !== undefined) set("employee_id_label", dto.employeeId || null);
      if (dto.candidateId !== undefined) set("candidate_id_label", dto.candidateId || null);
      if (dto.jobContractFileName !== undefined) set("job_contract_file_reference", dto.jobContractFileName);
      if (dto.startDate !== undefined) {
        if (!dto.startDate.trim()) throw new BadRequestException("Start date cannot be cleared - it's a required field.");
        set("date_of_joining", dto.startDate);
      }
      if (dto.reportingManager !== undefined) set("reporting_manager_name", dto.reportingManager || null);
      if (dto.photoFileName !== undefined) set("photo_file_reference", dto.photoFileName);
      if (dto.hourlyRate !== undefined) set("hourly_rate", dto.hourlyRate ? Number(dto.hourlyRate) : null);
      set("updated_at", new Date());

      if (sets.length) {
        try {
          values.push(id);
          await client.query(`UPDATE employee.employee_master SET ${sets.join(", ")} WHERE id = $${i}`, values);
        } catch (err: any) {
          if (err?.constraint === "uq_employee_tenant_ni") {
            throw new ConflictException("A record with this National Insurance number already exists.");
          }
          throw err;
        }
      }

      await this.writeChildRecords(client, tenantId, id, dto);
      return { id };
    });
  }

  async updateStatus(tenantId: string, id: string, recordStatus: EmployeeStatus): Promise<{ id: string; recordStatus: EmployeeStatus }> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        "UPDATE employee.employee_master SET record_status = $1, updated_at = now() WHERE id = $2 AND NOT is_deleted RETURNING id, record_status",
        [recordStatus, id]
      );
      if (!result.rowCount) throw new NotFoundException("Employee not found.");
      return { id: result.rows[0].id, recordStatus: result.rows[0].record_status };
    });
  }

  /** Writes every repeatable/1:1 child table that's present in the
   * payload. A key being *absent* leaves that section untouched (so a
   * PATCH to just one wizard step doesn't wipe unrelated sections); a
   * key being present - even an empty array - replaces that section's
   * rows entirely, matching the wizard's "resubmit this whole step"
   * editing model. */
  private async writeChildRecords(client: PoolClient, tenantId: string, employeeId: string, dto: Partial<EmployeeUpsertDto>) {
    if (dto.emails || dto.phones || dto.addresses) {
      // All three share one table, so if any is present, only that
      // contact_type's rows are replaced - the other two types are left
      // alone unless they were also included in this payload.
      if (dto.emails) {
        await client.query("DELETE FROM employee.employee_contact_detail WHERE employee_id = $1 AND contact_type = 'email'", [employeeId]);
        for (const e of dto.emails) {
          await client.query(
            `INSERT INTO employee.employee_contact_detail (tenant_id, employee_id, contact_type, contact_subtype, value, is_primary)
             VALUES ($1,$2,'email',$3,$4,$5)`,
            [tenantId, employeeId, e.type, e.email, e.isPrimary]
          );
        }
      }
      if (dto.phones) {
        await client.query("DELETE FROM employee.employee_contact_detail WHERE employee_id = $1 AND contact_type = 'phone'", [employeeId]);
        for (const ph of dto.phones) {
          await client.query(
            `INSERT INTO employee.employee_contact_detail (tenant_id, employee_id, contact_type, contact_subtype, value, is_primary)
             VALUES ($1,$2,'phone',$3,$4,$5)`,
            [tenantId, employeeId, ph.type, ph.number, ph.isPrimary]
          );
        }
      }
      if (dto.addresses) {
        await client.query("DELETE FROM employee.employee_contact_detail WHERE employee_id = $1 AND contact_type = 'address'", [employeeId]);
        for (const a of dto.addresses) {
          await client.query(
            `INSERT INTO employee.employee_contact_detail
              (tenant_id, employee_id, contact_type, contact_subtype, line1, line2, city, county, postcode, country, is_primary)
             VALUES ($1,$2,'address',$3,$4,$5,$6,$7,$8,$9,$10)`,
            [tenantId, employeeId, a.type, a.line1, a.line2 || null, a.city, a.county || null, a.postcode, a.country || null, a.isPrimary]
          );
        }
      }
    }

    if (dto.emergencyFullName !== undefined) {
      await client.query("DELETE FROM employee.employee_emergency_contact WHERE employee_id = $1", [employeeId]);
      if (dto.emergencyFullName) {
        await client.query(
          `INSERT INTO employee.employee_emergency_contact (tenant_id, employee_id, full_name, relationship, primary_phone, secondary_phone, address)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [tenantId, employeeId, dto.emergencyFullName, dto.emergencyRelationship || "", dto.emergencyPrimaryPhone || "", dto.emergencySecondaryPhone || null, dto.emergencyAddress || null]
        );
      }
    }

    if (dto.accountHolderName !== undefined || dto.bankName !== undefined || dto.accountNumber !== undefined) {
      const accountNumberEnc = await encrypt(client, dto.accountNumber);
      const sortCodeEnc = await encrypt(client, dto.sortCode);
      const ibanEnc = await encrypt(client, dto.iban);
      await client.query(
        `INSERT INTO employee.employee_bank_detail (tenant_id, employee_id, account_holder_name, bank_name, account_number_encrypted, sort_code_encrypted, iban_encrypted, document_file_reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (employee_id) DO UPDATE SET
           account_holder_name = EXCLUDED.account_holder_name, bank_name = EXCLUDED.bank_name,
           account_number_encrypted = EXCLUDED.account_number_encrypted, sort_code_encrypted = EXCLUDED.sort_code_encrypted,
           iban_encrypted = EXCLUDED.iban_encrypted, document_file_reference = EXCLUDED.document_file_reference`,
        [tenantId, employeeId, dto.accountHolderName || null, dto.bankName || null, accountNumberEnc, sortCodeEnc, ibanEnc, dto.bankDocumentFileName || null]
      );
    }

    if (dto.education) {
      await client.query("DELETE FROM employee.employee_qualification WHERE employee_id = $1", [employeeId]);
      for (const ed of dto.education) {
        await client.query(
          `INSERT INTO employee.employee_qualification (tenant_id, employee_id, institution, qualification, field_of_study, start_date, end_date, grade, certificate_file_reference)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [tenantId, employeeId, ed.institution || null, ed.qualification || null, ed.fieldOfStudy || null, ed.startDate || null, ed.endDate || null, ed.grade || null, ed.certificateFileName || null]
        );
      }
    }

    if (dto.certifications) {
      await client.query("DELETE FROM employee.employee_certification WHERE employee_id = $1", [employeeId]);
      for (const c of dto.certifications) {
        await client.query(
          `INSERT INTO employee.employee_certification (tenant_id, employee_id, name, issuing_body, certificate_number, issue_date, expiry_date, file_reference)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [tenantId, employeeId, c.name || null, c.issuingBody || null, c.certificateNumber || null, c.issueDate || null, c.expiryDate || null, c.fileName || null]
        );
      }
    }

    if (dto.passportNumber !== undefined) {
      await client.query(
        `INSERT INTO employee.employee_passport_detail (tenant_id, employee_id, passport_number, issuing_country, issue_date, expiry_date, file_reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (employee_id) DO UPDATE SET
           passport_number = EXCLUDED.passport_number, issuing_country = EXCLUDED.issuing_country,
           issue_date = EXCLUDED.issue_date, expiry_date = EXCLUDED.expiry_date, file_reference = EXCLUDED.file_reference`,
        [tenantId, employeeId, dto.passportNumber || null, dto.passportIssuingCountry || null, dto.passportIssueDate || null, dto.passportExpiryDate || null, dto.passportFileName || null]
      );
    }

    if (dto.visaType !== undefined || dto.visaExpiryDate !== undefined) {
      await client.query(
        `INSERT INTO employee.employee_visa_detail (tenant_id, employee_id, visa_type, visa_number, issue_date, expiry_date, conditions, file_reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (employee_id) DO UPDATE SET
           visa_type = EXCLUDED.visa_type, visa_number = EXCLUDED.visa_number, issue_date = EXCLUDED.issue_date,
           expiry_date = EXCLUDED.expiry_date, conditions = EXCLUDED.conditions, file_reference = EXCLUDED.file_reference`,
        [tenantId, employeeId, dto.visaType || null, dto.visaNumber || null, dto.visaIssueDate || null, dto.visaExpiryDate || null, Array.isArray(dto.visaConditions) && dto.visaConditions.length ? dto.visaConditions.join(",") : null, dto.visaFileName || null]
      );
    }

    if (dto.cosLicenceNumber !== undefined) {
      await client.query(
        `INSERT INTO employee.employee_cos_detail (tenant_id, employee_id, licence_number, sponsor_name, certificate_number, certificate_date, assigned_date, expiry_date, sponsor_note, file_reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (employee_id) DO UPDATE SET
           licence_number = EXCLUDED.licence_number, sponsor_name = EXCLUDED.sponsor_name,
           certificate_number = EXCLUDED.certificate_number, certificate_date = EXCLUDED.certificate_date,
           assigned_date = EXCLUDED.assigned_date, expiry_date = EXCLUDED.expiry_date,
           sponsor_note = EXCLUDED.sponsor_note, file_reference = EXCLUDED.file_reference`,
        [tenantId, employeeId, dto.cosLicenceNumber || null, dto.cosSponsorName || null, dto.cosCertificateNumber || null, dto.cosCertificateDate || null, dto.cosAssignedDate || null, dto.cosExpiryDate || null, dto.cosSponsorNote || null, dto.cosFileName || null]
      );
    }

    if (dto.rtwChecks) {
      await client.query("DELETE FROM employee.employee_rtw_check WHERE employee_id = $1", [employeeId]);
      for (const r of dto.rtwChecks) {
        await client.query(
          `INSERT INTO employee.employee_rtw_check (tenant_id, employee_id, share_code, rtw_reference, date_of_check, status, expiry_date, attachment_file_reference)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [tenantId, employeeId, r.shareCode || null, r.rtwReference || null, r.dateOfCheck || null, r.status || null, r.expiryDate || null, r.attachmentFileName || null]
        );
      }
    }

    if (dto.documents) {
      await client.query("DELETE FROM employee.employee_document WHERE employee_id = $1", [employeeId]);
      for (const d of dto.documents) {
        await client.query(
          `INSERT INTO employee.employee_document (tenant_id, employee_id, file_reference, document_type, description, expiry_date)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [tenantId, employeeId, d.fileName, d.documentType || null, d.description || null, d.expiryDate || null]
        );
      }
    }
  }
}
