import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { PoolClient } from "pg";
import { authPool, withTenant } from "../db";
import { AuthService } from "../auth/auth.service";
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
  DependantEntryDto,
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

/** Atomic per-tenant counter (see migrations/022_sequence_counter.sql)
 * - the UPSERT...RETURNING is what makes this safe under concurrent
 * creates, unlike reading a max value and adding one. */
async function nextSequenceNumber(client: PoolClient, tenantId: string, sequenceName: string, prefix: string, digits: number): Promise<string> {
  const result = await client.query(
    `INSERT INTO reference.sequence_counter (tenant_id, sequence_name, next_value)
     VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, sequence_name) DO UPDATE SET next_value = reference.sequence_counter.next_value + 1
     RETURNING next_value`,
    [tenantId, sequenceName]
  );
  return `${prefix}${String(result.rows[0].next_value).padStart(digits, "0")}`;
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
  // Grouped by which wizard stepper each field lives on, so the error
  // tells the caller where to go fix it rather than just what's wrong.
  // "Role Details / Work Details" covers both names since this one
  // endpoint serves Candidate Onboarding's finalize (stepper is called
  // "Role Details" there) and Employee Register's ("Work Details").
  const personalMissing: string[] = [];
  if (!dto.firstName?.trim()) personalMissing.push("First name");
  if (!dto.lastName?.trim()) personalMissing.push("Last name");
  if (!dto.dateOfBirth?.trim()) personalMissing.push("Date of birth");

  // Employee Register's "Add Employee" (onboardedOnCreate) requires the
  // Actual Joining date; Candidate Onboarding's own finalize
  // (onboardedOnCreate never set) requires the Proposed joining date
  // instead - these are two distinct fields now (see startDate's own
  // comment on EmployeeFormData), not one field finalized by two
  // different callers.
  const roleMissing: string[] = [];
  if (!dto.jobTitle?.trim()) roleMissing.push("Job title");
  if (!dto.department?.trim()) roleMissing.push("Department");
  if (dto.onboardedOnCreate) {
    if (!dto.startDate?.trim()) roleMissing.push("Actual Joining date");
  } else {
    if (!dto.proposedJoiningDate?.trim()) roleMissing.push("Proposed joining date");
  }

  const messages: string[] = [];
  if (personalMissing.length) messages.push(`Personal - Missing required field(s): ${personalMissing.join(", ")}`);
  if (roleMissing.length) messages.push(`Role Details / Work Details - Missing required field(s): ${roleMissing.join(", ")}`);

  if (messages.length) {
    throw new BadRequestException(messages.join("; "));
  }
}

@Injectable()
export class EmployeeService implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly authService: AuthService) {}

  private lapseTimer?: NodeJS.Timeout;
  private lastLapseSweep = new Map<string, number>();

  /** Cloud Run can scale to zero, so the sweep also runs whenever the employee list is loaded (see list()); this
   * hourly timer just covers a long-running instance with nobody browsing. */
  onModuleInit() {
    const run = async () => {
      try {
        const tenants = await authPool.query("SELECT DISTINCT tenant_id FROM security.credential");
        for (const t of tenants.rows) await this.deactivateLapsedEmployees(t.tenant_id, true);
      } catch (err) {
        console.error("Lapsed-employee sweep failed:", err instanceof Error ? err.message : err);
      }
    };
    void run();
    this.lapseTimer = setInterval(run, 60 * 60 * 1000);
    this.lapseTimer.unref();
  }

  onModuleDestroy() {
    if (this.lapseTimer) clearInterval(this.lapseTimer);
  }

  /** An Active employee becomes Inactive once their contract end date, or the last working day of an approved
   * resignation, is in the past. Returns how many were changed. Throttled to once per 10 minutes per tenant
   * unless forced. */
  async deactivateLapsedEmployees(tenantId: string, force = false): Promise<number> {
    const last = this.lastLapseSweep.get(tenantId) ?? 0;
    if (!force && Date.now() - last < 10 * 60 * 1000) return 0;
    this.lastLapseSweep.set(tenantId, Date.now());
    return withTenant(tenantId, async (client) => {
      const r = await client.query(
        `UPDATE employee.employee_master m SET record_status = 'Inactive', updated_at = now()
         WHERE m.tenant_id = $1 AND NOT m.is_deleted AND m.is_onboarded AND m.record_status = 'Active'
           AND (m.contract_end_date < CURRENT_DATE
                OR EXISTS (SELECT 1 FROM employee.resignation_request rr
                           WHERE rr.employee_id = m.id AND rr.status = 'approved' AND rr.tentative_last_date < CURRENT_DATE))`,
        [tenantId]
      );
      return r.rowCount ?? 0;
    });
  }

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

  /** Every visa / right-to-work / passport / CoS expiry on Active, onboarded employees (Visa and CoS only for
   * sponsored ones, like the dashboard), plus the tenant's sponsor licence details. Days are counted from today. */
  async listExpiries(tenantId: string) {
    return withTenant(tenantId, async (client) => {
      const base = `m.record_status = 'Active' AND m.is_onboarded AND NOT m.is_deleted`;
      const cols = `m.id AS employee_uuid, m.employee_id_label, m.first_name, m.middle_name, m.last_name, m.job_title, m.current_location,
                     m.date_of_joining, m.soc_number, d.name AS department,
                     (SELECT value FROM employee.employee_contact_detail c WHERE c.employee_id = m.id AND c.contact_type = 'email' AND c.is_primary AND NOT c.is_removed LIMIT 1) AS work_email`;
      const from = `FROM employee.employee_master m LEFT JOIN reference.department d ON d.id = m.department_id`;
      const sql = `
        SELECT 'Visa' AS type, COALESCE(NULLIF(v.visa_type, ''), 'Visa') AS document_check, v.expiry_date, v.visa_number AS document_number, v.issue_date,
               (SELECT licence_number FROM employee.employee_cos_detail x WHERE x.employee_id = m.id) AS licence_number,
               (SELECT certificate_number FROM employee.employee_cos_detail x WHERE x.employee_id = m.id) AS certificate_number, ${cols}
          ${from} JOIN employee.employee_visa_detail v ON v.employee_id = m.id
          WHERE ${base} AND m.sponsored_employee AND v.expiry_date IS NOT NULL
        UNION ALL
        SELECT 'Right to Work', 'Right to Work Check', r.expiry_date, r.rtw_reference, r.date_of_check, NULL, NULL, ${cols}
          ${from} JOIN LATERAL (SELECT * FROM employee.employee_rtw_check x WHERE x.employee_id = m.id AND x.expiry_date IS NOT NULL ORDER BY x.date_of_check DESC NULLS LAST LIMIT 1) r ON true
          WHERE ${base}
        UNION ALL
        SELECT 'Passport', 'Passport', p.expiry_date, p.passport_number, p.issue_date, NULL, NULL, ${cols}
          ${from} JOIN employee.employee_passport_detail p ON p.employee_id = m.id
          WHERE ${base} AND p.expiry_date IS NOT NULL
        UNION ALL
        SELECT 'CoS', 'Certificate of Sponsorship', c.expiry_date, c.certificate_number, c.certificate_date, c.licence_number, c.certificate_number, ${cols}
          ${from} JOIN employee.employee_cos_detail c ON c.employee_id = m.id
          WHERE ${base} AND m.sponsored_employee AND c.expiry_date IS NOT NULL`;
      const r = await client.query(`SELECT t.*, (t.expiry_date - CURRENT_DATE) AS days FROM (${sql}) t ORDER BY t.expiry_date, t.first_name`);
      const records = r.rows.map((x) => {
        const name = [x.first_name, x.middle_name, x.last_name].filter(Boolean).join(" ");
        return {
          employeeUuid: x.employee_uuid as string,
          employeeId: (x.employee_id_label ?? "") as string,
          name,
          initials: [x.first_name, x.last_name].filter(Boolean).map((n: string) => n[0]).join("").toUpperCase() || "?",
          role: (x.job_title ?? "") as string,
          type: x.type as string,
          documentCheck: x.document_check as string,
          expiryDate: toDateStr(x.expiry_date),
          daysToExpiry: Number(x.days),
          department: (x.department ?? "") as string,
          location: (x.current_location ?? "") as string,
          workEmail: (x.work_email ?? "") as string,
          startDate: toDateStr(x.date_of_joining),
          documentNumber: (x.document_number ?? undefined) as string | undefined,
          issueDate: toDateStr(x.issue_date) || undefined,
          sponsorLicenceNumber: (x.licence_number ?? undefined) as string | undefined,
          certificateOfSponsorship: (x.certificate_number ?? undefined) as string | undefined,
          occupationCode: (x.soc_number ?? undefined) as string | undefined,
        };
      });
      const p = await client.query("SELECT sponsor_licence_number, sponsor_name FROM reference.employer_profile WHERE tenant_id = $1", [tenantId]);
      return { records, licence: { licenceNumber: p.rows[0]?.sponsor_licence_number ?? null, sponsorName: p.rows[0]?.sponsor_name ?? null } };
    });
  }

  /** Employees no longer part of the organisation (status Inactive). "Left on" is the last working day of an
   * approved resignation, else the contract end date, else the day the record was made Inactive. from/to filter
   * on that date (inclusive). */
  async listFormer(tenantId: string, q?: string, from?: string, to?: string) {
    await this.deactivateLapsedEmployees(tenantId).catch(() => 0);
    const isDate = (v?: string) => !!v && /^d{4}-d{2}-d{2}$/.test(v);
    return withTenant(tenantId, async (client) => {
      const r = await client.query(
        `SELECT * FROM (
           SELECT m.id, m.employee_id_label, m.first_name, m.middle_name, m.last_name, m.job_title, d.name AS department,
                  m.date_of_joining, m.contract_end_date,
                  rr.lwd AS resignation_date,
                  COALESCE(rr.lwd, m.contract_end_date, m.updated_at::date) AS left_on,
                  CASE WHEN rr.lwd IS NOT NULL THEN 'Resigned' WHEN m.contract_end_date IS NOT NULL THEN 'Contract ended' ELSE 'Deactivated' END AS reason
           FROM employee.employee_master m
           LEFT JOIN reference.department d ON d.id = m.department_id
           LEFT JOIN LATERAL (SELECT max(tentative_last_date) AS lwd FROM employee.resignation_request x WHERE x.employee_id = m.id AND x.status = 'approved') rr ON true
           WHERE NOT m.is_deleted AND m.is_onboarded AND m.record_status = 'Inactive'
         ) t
         WHERE ($1::text IS NULL OR lower(concat_ws(' ', first_name, middle_name, last_name, employee_id_label, job_title, department)) LIKE '%' || lower($1) || '%')
           AND ($2::date IS NULL OR left_on >= $2::date) AND ($3::date IS NULL OR left_on <= $3::date)
         ORDER BY left_on DESC, first_name`,
        [q?.trim() || null, isDate(from) ? from : null, isDate(to) ? to : null]
      );
      return r.rows.map((x) => ({
        recordId: x.id,
        employeeId: x.employee_id_label ?? "",
        fullName: [x.first_name, x.middle_name, x.last_name].filter(Boolean).join(" "),
        jobTitle: x.job_title ?? "",
        department: x.department ?? "",
        joinedOn: toDateStr(x.date_of_joining),
        leftOn: toDateStr(x.left_on),
        reason: x.reason as string,
      }));
    });
  }

  async list(
    tenantId: string,
    page: number,
    pageSize: number,
    onboarded?: boolean
  ): Promise<{ items: EmployeeSummary[]; total: number; page: number; pageSize: number }> {
    await this.deactivateLapsedEmployees(tenantId).catch(() => 0);
    return withTenant(tenantId, async (client) => {
      const offset = (page - 1) * pageSize;
      // `onboarded` filters which side of the pipeline a caller wants:
      // Candidate Onboarding / Pre-Employment Compliance Check /
      // Employee Onboarding all want is_onboarded = false (still in
      // the pre-hire pipeline); Employee Register wants true (actually
      // onboarded). Omitted entirely returns everyone, for callers
      // that genuinely don't care about the distinction.
      const onboardedClause = onboarded === undefined ? "" : "AND m.is_onboarded = $3";
      const params = onboarded === undefined ? [pageSize, offset] : [pageSize, offset, onboarded];
      const countClause = onboarded === undefined ? "" : "AND is_onboarded = $1";
      const countParams = onboarded === undefined ? [] : [onboarded];
      // Employee Register (onboarded=true) wants to see its own Draft
      // rows too - a directly-added employee finalize() held at Draft
      // pending Pre-Hire Compliance (see update()'s own comment on the
      // Draft -> Active promotion) still needs to be visible there so
      // HR can find and complete it, just labelled "Draft" rather than
      // silently missing. A genuinely still-being-filled-in wizard
      // draft never reaches here either way, since is_onboarded only
      // becomes true once finalize() actually runs. Candidate
      // Onboarding and every other caller (onboarded=false/undefined)
      // keeps excluding Draft - those are real works-in-progress, not
      // finished records pending a check.
      const excludeDraftClause = onboarded === true ? "" : "AND m.record_status != 'Draft'";
      const excludeDraftCountClause = onboarded === true ? "" : "AND record_status != 'Draft'";

      const [rows, count] = await Promise.all([
        client.query(
          `SELECT m.id, m.employee_reference_no, m.candidate_id_label, m.employee_id_label, m.first_name, m.middle_name, m.last_name,
                  m.job_title, m.record_status, m.date_of_joining, m.proposed_joining_date, m.current_location, m.photo_file_reference, m.is_onboarded, m.sponsored_employee, m.contract_duration,
                  m.is_uk_citizen, m.is_ilr_settled,
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
                     SELECT status, statutory_excuse_established, date_of_check, expiry_date
                     FROM employee.employee_rtw_check WHERE employee_id = m.id
                     ORDER BY date_of_check DESC NULLS LAST LIMIT 1
                   ) r) AS rtw
           FROM employee.employee_master m
           JOIN reference.department d ON d.id = m.department_id
           WHERE NOT m.is_deleted ${excludeDraftClause} ${onboardedClause}
           ORDER BY m.created_at DESC
           LIMIT $1 OFFSET $2`,
          params
        ),
        client.query(
          `SELECT count(*)::int AS n FROM employee.employee_master WHERE NOT is_deleted ${excludeDraftCountClause} ${countClause}`,
          countParams
        ),
      ]);

      return {
        items: rows.rows.map((r) => ({
          id: r.id,
          employeeReferenceNo: r.employee_reference_no,
          candidateId: r.candidate_id_label ?? "",
          employeeId: r.employee_id_label ?? "",
          fullName: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(" "),
          jobTitle: r.job_title,
          department: r.department_name,
          recordStatus: r.record_status,
          isOnboarded: r.is_onboarded,
          sponsoredEmployee: !!r.sponsored_employee,
          isUkCitizen: r.is_uk_citizen !== false,
          contractDuration: r.contract_duration ?? null,
          primaryEmail: r.primary_email ?? null,
          primaryPhone: r.primary_phone ?? null,
          currentLocation: r.current_location ?? null,
          startDate: toDateStr(r.date_of_joining) || null,
          proposedJoiningDate: toDateStr(r.proposed_joining_date) || null,
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
   * CoS/Visa record is still "In Progress").
   *
   * A UK citizen or someone with ILR/Settled Status is exempt from
   * Sponsorship Assessment, CoS and Visa entirely (see WorkStep's own
   * exemptFromSponsorship) - those three are reported as "Completed"
   * for them regardless of whether any record exists, so Right to Work
   * alone gates their readiness to onboard (hasPassedCompliance
   * requires every check "Completed") rather than leaving them stuck
   * forever on checks that will never apply to them. */
  private static buildComplianceChecks(r: any): EmployeeSummary["complianceChecks"] {
    const exempt = r.is_uk_citizen === true || r.is_ilr_settled === true;
    const assessment = r.latest_assessment;
    const cos = r.cos;
    const visa = r.visa;
    const rtw = r.rtw;

    const assessmentStatus = exempt ? "Completed" : !assessment ? "Not Started" : assessment.decision ? "Completed" : "In Progress";
    const cosStatus = exempt
      ? "Completed"
      : !cos || (!cos.licence_number && !cos.sponsor_name && !cos.certificate_number)
      ? "Not Started"
      : cos.certificate_number && cos.assigned_date && cos.expiry_date
      ? "Completed"
      : "In Progress";
    const visaStatus = exempt
      ? "Completed"
      : !visa || (!visa.visa_type && !visa.visa_number)
      ? "Not Started"
      : visa.visa_type && visa.visa_number && visa.expiry_date
      ? "Completed"
      : "In Progress";
    // "Approved"/"Pending"/"Rejected" (status) has no UI control that
    // ever sets it - statutory_excuse_established (Yes/No) is the
    // field the Right to Work form actually captures, so that's what
    // genuinely represents whether this check succeeded.
    const rtwStatus = !rtw ? "Not Started" : rtw.statutory_excuse_established === "Yes" ? "Completed" : "In Progress";

    return [
      {
        type: "assessment",
        status: assessmentStatus,
        // No natural "next check due" concept for Assessment (unlike
        // CoS/Visa/RTW, which have real expiry dates) - previously
        // stood in with the candidate's start date, but that read as
        // a recheck date rather than what it actually meant. Left
        // blank for now rather than reusing a misleading proxy.
        nextCheckDate: null,
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
    return withTenant(tenantId, (client) => this.getByIdCore(client, tenantId, id));
  }

  /** Extracted from getById so update() can fetch the pre-change values
   * within its own transaction (same client, same withTenant call) to
   * build the change-history diff - calling the public getById() from
   * inside update() would open a second, separate transaction instead
   * of reusing the one already in progress. */
  private async getByIdCore(client: PoolClient, tenantId: string, id: string): Promise<EmployeeUpsertDto & { id: string; recordStatus: EmployeeStatus }> {
    const masterRes = await client.query(
      `SELECT m.*, d.name AS department_name
       FROM employee.employee_master m
       LEFT JOIN reference.department d ON d.id = m.department_id
       WHERE m.id = $1 AND NOT m.is_deleted`,
      [id]
    );
    if (!masterRes.rowCount) throw new NotFoundException("Employee not found.");
    const m = masterRes.rows[0];

    const [contacts, emergency, bank, quals, certs, passport, visa, cos, rtw, docs, dependants] = await Promise.all([
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
      client.query("SELECT * FROM employee.employee_dependant WHERE employee_id = $1", [id]),
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
      firstName: m.first_name ?? "",
      middleName: m.middle_name ?? "",
      lastName: m.last_name ?? "",
      dateOfBirth: toDateStr(m.date_of_birth),
      gender: m.gender ?? "",
      nationality: m.nationality ?? "",
      maritalStatus: m.marital_status ?? "",
      nationalInsuranceNumber: ni ?? "",
      isUkCitizen: m.is_uk_citizen === false ? "No" : "Yes",
      isIlrSettled: m.is_ilr_settled === true ? "Yes" : "No",

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
      jobTitle: m.job_title ?? "",
      department: m.department_name ?? "",
      projectWorkBranch: m.project_work_branch ?? "",
      reportingManager: m.reporting_manager_name ?? "",
      employmentType: m.employment_type ?? "",
      startDate: toDateStr(m.date_of_joining),
      proposedJoiningDate: toDateStr(m.proposed_joining_date),
      workLocation: m.work_location ?? "",
      workTiming: m.work_timing ?? "",
      standardHoursPerWeek: m.standard_hours_per_week?.toString() ?? "",
      hourlyRate: m.hourly_rate?.toString() ?? "",
      socNumber: m.soc_number ?? "",
      jobDescription: m.job_description ?? "",
      contractDuration: m.contract_duration ?? "",
      contractEndDate: toDateStr(m.contract_end_date),
      currentLocation: m.current_location ?? "",
      currentImmigrationStatus: m.current_immigration_status ?? "",
      rtwEngagementType: m.rtw_engagement_type ?? "",
      proposedAnnualSalary: m.proposed_annual_salary != null ? String(m.proposed_annual_salary) : "",
      salaryOffered: m.salary_offered ?? "",
      guaranteedBasicGrossPay: m.guaranteed_basic_gross_pay ?? "",
      jobContractFileName: m.job_contract_file_reference,
      sponsoredEmployee: m.sponsored_employee ? "Yes" : "No",
      sponsorshipVisaRoute: m.sponsorship_visa_route ?? "",

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
      cosApplyingFrom: c?.applying_from ?? "",
      cosType: c?.cos_type ?? "",
      cosGenuineVacancyConfirmed: c?.genuine_vacancy_confirmed ?? "",
      cosGenuineVacancyConfirmedDate: toDateStr(c?.genuine_vacancy_confirmed_date),
      cosAssignedSalary: c?.cos_assigned_salary ?? "",
      cosPayFrequency: c?.cos_pay_frequency ?? "",
      cosSponsorNote: c?.sponsor_note ?? "",
      cosFileName: c?.file_reference ?? null,

      rtwChecks: rtw.rows.map((r): RtwCheckEntryDto => ({
        id: r.id, checkMethod: r.check_method, documentEvidenceType: r.document_evidence_type,
        documentType: r.document_type, documentExpiryDate: toDateStr(r.document_expiry_date),
        pvnDate: toDateStr(r.pvn_date),
        shareCode: r.share_code, rtwReference: r.rtw_reference,
        onlineCodeIssuedDate: toDateStr(r.online_code_issued_date),
        onlinePermissionLimit: r.online_permission_limit, onlineExpiryDate: toDateStr(r.online_expiry_date),
        idspProvider: r.idsp_provider,
        checkedByName: r.checked_by_name, checkedByRole: r.checked_by_role,
        dateOfCheck: toDateStr(r.date_of_check),
        photoMatchConfirmed: !!r.photo_match_confirmed, knownReasonableCauseFlag: !!r.known_reasonable_cause_flag,
        statutoryExcuseEstablished: r.statutory_excuse_established,
        status: r.status, expiryDate: toDateStr(r.expiry_date), remarks: r.remarks,
        attachmentFileName: r.attachment_file_reference,
      })),
      dependants: dependants.rows.map((r): DependantEntryDto => ({
        id: r.id, name: r.name, relationship: r.relationship, dateOfBirth: toDateStr(r.date_of_birth),
      })),
      documents: docs.rows.map((r): DocumentEntryDto => ({
        id: r.id, fileName: r.file_reference, documentType: r.document_type,
        description: r.description, expiryDate: toDateStr(r.expiry_date),
      })),
    };
  }

  /** Creates the near-empty row a wizard needs to exist *before* the
   * user has entered anything real, purely so document-evidence
   * uploads (which carry a hard FK to this table) have something
   * valid to reference from step one. `clientId` lets the frontend
   * generate the id up front and use it consistently for every
   * PATCH and upload from the very first render, rather than getting
   * an id back only after some round trip. Every other field stays
   * NULL until finalize() (or a plain update() along the way) fills
   * it in - see migrations/023_employee_draft_support.sql for why
   * that's allowed at the DB level now.
   *
   * Neither employee_id_label nor candidate_id_label is reserved here,
   * for either flow - both used to be assigned immediately on draft
   * creation, before the record even had a name on it, which burns a
   * sequence number on every abandoned draft (someone opens Add
   * Candidate/Add Employee and never finishes) as well as - in local
   * dev specifically - every double-fired React Strict Mode mount.
   * Both are generated by finalize() instead, on the actual click of
   * Save, so a number is only ever spent on a record that actually
   * gets saved. */
  async createDraft(tenantId: string, clientId: string | undefined): Promise<{ id: string }> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO employee.employee_master
          (id, tenant_id, employee_reference_no, record_status, is_onboarded)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, 'Draft', false)
         RETURNING id`,
        [clientId ?? null, tenantId, genRef()]
      );
      return { id: result.rows[0].id };
    });
  }

  /** Promotes a Draft to Active. Re-runs the same required-field
   * validation that used to gate create() itself, now deferred to
   * here since the row already exists by the time the wizard reaches
   * Review & Submit. A record that's already Active just falls
   * through to a normal update() - a double-submit (e.g. a retried
   * request) shouldn't error just because it isn't a draft anymore. */
  async finalize(tenantId: string, id: string, dto: EmployeeUpsertDto): Promise<{ id: string }> {
    assertRequiredFields(dto);
    return withTenant(tenantId, async (client) => {
      const existing = await client.query(
        "SELECT record_status, employee_id_label, candidate_id_label FROM employee.employee_master WHERE id = $1 AND NOT is_deleted",
        [id]
      );
      if (!existing.rowCount) throw new NotFoundException("Employee not found.");
      if (existing.rows[0].record_status !== "Draft") {
        return this.update(tenantId, id, dto);
      }

      const departmentId = await this.resolveDepartmentId(client, tenantId, dto.department);
      const niEncrypted = await encrypt(client, dto.nationalInsuranceNumber);
      const niHash = await hmacHash(client, dto.nationalInsuranceNumber);

      // Neither id is reserved at draft-creation time any more (see
      // createDraft's own comment) - both are assigned here instead, on
      // the click of Save, each only if not already set (idempotent
      // against a retried finalize). Employee Register's "Add Employee"
      // flow (onboardedOnCreate) gets an Employee Number; Candidate
      // Onboarding's own finalize (onboardedOnCreate never set) gets a
      // Candidate ID instead - never both, since a record is either a
      // candidate or a directly-added employee, not both at once.
      const employeeIdLabel =
        dto.onboardedOnCreate && !existing.rows[0].employee_id_label
          ? await nextSequenceNumber(client, tenantId, "employee_number", "E", 6)
          : existing.rows[0].employee_id_label;
      const candidateIdLabel =
        !dto.onboardedOnCreate && !existing.rows[0].candidate_id_label
          ? await nextSequenceNumber(client, tenantId, "candidate_id", "C", 6)
          : existing.rows[0].candidate_id_label;

      // Employee Register's "Add Employee" (onboardedOnCreate) skips
      // Candidate Onboarding's own pre-hire pipeline entirely, so
      // nothing has verified this person's Right to Work yet by the
      // time they hit Save here - finalizing straight to Active would
      // let them go live with zero pre-employment checks done. Holding
      // at Draft until Pre-Hire Compliance is complete (RTW is the only
      // check type with real persisted state today, see the comment on
      // PreEmploymentChecksTab) forces that gap to be closed via
      // update() below, which promotes Draft -> Active the moment an
      // RTW check lands. Candidate Onboarding's own finalize (never
      // onboardedOnCreate) already went through that pipeline - always
      // Active here, unaffected by this gate.
      const recordStatus = dto.onboardedOnCreate && !(dto.rtwChecks?.length) ? "Draft" : "Active";

      try {
        await client.query(
          `UPDATE employee.employee_master SET
             first_name=$1, middle_name=$2, last_name=$3, date_of_birth=$4, gender=$5, marital_status=$6,
             nationality=$7, ni_number_encrypted=$8, ni_number_hash=$9, job_title=$10, department_id=$11,
             employment_type=$12, work_location=$13, work_timing=$14, standard_hours_per_week=$15, soc_number=$16,
             project_work_branch=$17, sponsored_employee=$18, job_contract_file_reference=$19,
             date_of_joining=$20, reporting_manager_name=$21, photo_file_reference=$22, hourly_rate=$23,
             job_description=$24, contract_duration=$25, current_location=$26, current_immigration_status=$27,
             proposed_annual_salary=$28, rtw_engagement_type=$29, salary_offered=$30, guaranteed_basic_gross_pay=$31,
             is_uk_citizen=$32, is_ilr_settled=$33, employee_id_label=$34, candidate_id_label=$35, is_onboarded=$36,
             proposed_joining_date=$37, sponsorship_visa_route=$38, record_status=$39, contract_end_date=$40, updated_at=now()
           WHERE id=$41`,
          [
            dto.firstName, dto.middleName || null, dto.lastName, dto.dateOfBirth || null,
            dto.gender || null, dto.maritalStatus || null, dto.nationality || null, niEncrypted, niHash,
            dto.jobTitle, departmentId, dto.employmentType || null, dto.workLocation || null,
            dto.workTiming || null, dto.standardHoursPerWeek ? Number(dto.standardHoursPerWeek) : null,
            dto.socNumber || null, dto.projectWorkBranch || null, dto.sponsoredEmployee === "Yes",
            dto.jobContractFileName || null,
            dto.startDate || null, dto.reportingManager || null, dto.photoFileName || null,
            dto.hourlyRate ? Number(dto.hourlyRate) : null,
            dto.jobDescription || null, dto.contractDuration || null, dto.currentLocation || null, dto.currentImmigrationStatus || null,
            dto.proposedAnnualSalary ? Number(dto.proposedAnnualSalary) : null,
            dto.rtwEngagementType || null,
            dto.salaryOffered || null,
            dto.guaranteedBasicGrossPay || null,
            dto.isUkCitizen !== "No",
            dto.isIlrSettled === "Yes",
            employeeIdLabel,
            candidateIdLabel,
            !!dto.onboardedOnCreate || employeeIdLabel != null,
            dto.proposedJoiningDate || null,
            dto.sponsorshipVisaRoute || null,
            recordStatus,
            dto.contractEndDate || null,
            id,
          ]
        );
      } catch (err: any) {
        if (err?.constraint === "uq_employee_tenant_ni") {
          throw new ConflictException("A record with this National Insurance number already exists.");
        }
        throw err;
      }

      await this.writeChildRecords(client, tenantId, id, dto);
      return { id };
    });
  }

  /** Legacy direct-create path (row didn't exist before this call) -
   * kept for any caller that isn't going through the draft-first
   * wizard flow. The wizards themselves now always createDraft() then
   * finalize(). */
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
      // System-generated, not user-entered - whatever the caller sent
      // for candidateId is ignored (the field is read-only on both
      // wizard frontends now).
      const candidateIdLabel = await nextSequenceNumber(client, tenantId, "candidate_id", "C", 6);
      // Employee Register's "Add Employee" page creates someone who's
      // already an employee, not a pre-hire candidate - they get an
      // Employee Number and is_onboarded=true immediately rather than
      // needing a separate Employee Onboarding action afterwards.
      const employeeIdLabel = dto.onboardedOnCreate
        ? await nextSequenceNumber(client, tenantId, "employee_number", "E", 6)
        : null;

      let masterId: string;
      try {
        const result = await client.query(
          `INSERT INTO employee.employee_master
            (tenant_id, employee_reference_no, first_name, middle_name, last_name, date_of_birth,
             gender, marital_status, nationality, ni_number_encrypted, ni_number_hash, job_title, department_id,
             employment_type, work_location, work_timing, standard_hours_per_week, soc_number,
             project_work_branch, sponsored_employee, employee_id_label, candidate_id_label,
             job_contract_file_reference, date_of_joining, reporting_manager_name, photo_file_reference, hourly_rate,
             job_description, contract_duration, current_location, current_immigration_status, proposed_annual_salary,
             is_onboarded, salary_offered, guaranteed_basic_gross_pay, is_uk_citizen, is_ilr_settled, proposed_joining_date,
             sponsorship_visa_route, contract_end_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40)
           RETURNING id`,
          [
            tenantId, genRef(), dto.firstName, dto.middleName || null, dto.lastName, dto.dateOfBirth || null,
            dto.gender || null, dto.maritalStatus || null, dto.nationality || null, niEncrypted, niHash,
            dto.jobTitle, departmentId, dto.employmentType || null, dto.workLocation || null,
            dto.workTiming || null, dto.standardHoursPerWeek ? Number(dto.standardHoursPerWeek) : null,
            dto.socNumber || null, dto.projectWorkBranch || null, dto.sponsoredEmployee === "Yes",
            employeeIdLabel, candidateIdLabel, dto.jobContractFileName || null,
            dto.startDate || null, dto.reportingManager || null, dto.photoFileName || null,
            dto.hourlyRate ? Number(dto.hourlyRate) : null,
            dto.jobDescription || null, dto.contractDuration || null, dto.currentLocation || null, dto.currentImmigrationStatus || null,
            dto.proposedAnnualSalary ? Number(dto.proposedAnnualSalary) : null,
            !!dto.onboardedOnCreate,
            dto.salaryOffered || null,
            dto.guaranteedBasicGrossPay || null,
            dto.isUkCitizen !== "No",
            dto.isIlrSettled === "Yes",
            dto.proposedJoiningDate || null,
            dto.sponsorshipVisaRoute || null,
            dto.contractEndDate || null,
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

  /** Every field this diff/history system tracks, mapped to the tab it
   * belongs to (shown as "Category" on the History tab) and a
   * human-readable label. Covers every scalar/single-row field across
   * both wizards - Bank Details and NI Number were previously excluded
   * here for the same reason they're encrypted at rest, but are now
   * included per an explicit decision to track them; their *values*
   * are still masked (maskIfSensitive below) rather than logged in
   * plain text, since encrypting a column at rest and then writing its
   * raw value into a plain-text audit log would defeat the point of
   * the encryption. True repeatable arrays (emails, phones, addresses,
   * education, certifications, dependants, documents, RTW checks) are
   * NOT listed here - they need item-level add/remove/change diffing,
   * not a single old/new string comparison, and are handled separately
   * by logArrayFieldChanges. */
  private readonly TRACKABLE_FIELDS: { key: keyof EmployeeUpsertDto; label: string; category: string; sensitive?: boolean }[] = [
    { key: "firstName", label: "First Name", category: "Personal" },
    { key: "middleName", label: "Middle Name", category: "Personal" },
    { key: "lastName", label: "Last Name", category: "Personal" },
    { key: "dateOfBirth", label: "Date of Birth", category: "Personal" },
    { key: "gender", label: "Gender", category: "Personal" },
    { key: "maritalStatus", label: "Marital Status", category: "Personal" },
    { key: "isUkCitizen", label: "Is a UK Citizen?", category: "Personal" },
    { key: "isIlrSettled", label: "Is ILR / Settled Status", category: "Personal" },
    { key: "nationality", label: "Nationality", category: "Personal" },
    { key: "nationalInsuranceNumber", label: "National Insurance Number", category: "Personal", sensitive: true },
    { key: "emergencyFullName", label: "Full Name", category: "Emergency Contact" },
    { key: "emergencyRelationship", label: "Relationship", category: "Emergency Contact" },
    { key: "emergencyPrimaryPhone", label: "Primary Phone", category: "Emergency Contact" },
    { key: "emergencySecondaryPhone", label: "Secondary Phone", category: "Emergency Contact" },
    { key: "emergencyAddress", label: "Address", category: "Emergency Contact" },
    { key: "jobTitle", label: "Job Title", category: "Work Details" },
    { key: "department", label: "Department", category: "Work Details" },
    { key: "projectWorkBranch", label: "Project / Work / Branch", category: "Work Details" },
    { key: "reportingManager", label: "Reporting Manager", category: "Work Details" },
    { key: "employmentType", label: "Employment Type", category: "Work Details" },
    { key: "startDate", label: "Actual Joining Date", category: "Work Details" },
    { key: "proposedJoiningDate", label: "Proposed Joining Date", category: "Work Details" },
    { key: "workLocation", label: "Work Location", category: "Work Details" },
    { key: "workTiming", label: "Work Timing", category: "Work Details" },
    { key: "standardHoursPerWeek", label: "Weekly Working Hours", category: "Work Details" },
    { key: "hourlyRate", label: "Hourly Rate", category: "Work Details" },
    { key: "socNumber", label: "SOC Number", category: "Work Details" },
    { key: "jobDescription", label: "Job Description", category: "Work Details" },
    { key: "contractDuration", label: "Contract Duration", category: "Work Details" },
    { key: "contractEndDate", label: "Contract End Date", category: "Work Details" },
    { key: "currentLocation", label: "Current Location", category: "Work Details" },
    { key: "currentImmigrationStatus", label: "Current Immigration Status", category: "Work Details" },
    { key: "rtwEngagementType", label: "RTW Engagement Type", category: "Work Details" },
    { key: "proposedAnnualSalary", label: "Proposed Annual Salary", category: "Work Details" },
    { key: "salaryOffered", label: "Salary Offered", category: "Work Details" },
    // salaryDiscountOption / isHealthAndCareRole are deliberately not
    // tracked here - they're SOC Details' non-binding salary preview
    // toggles, never persisted to a backend column at all, so there is
    // no real stored value to diff against. guaranteedBasicGrossPay
    // used to be grouped with these two but is now a real persisted
    // column (see migration 040) - still not tracked in change
    // history since it isn't gated by the pending-approval workflow
    // the way the rest of Work Details is; revisit if that changes.
    { key: "sponsoredEmployee", label: "To be Sponsored", category: "Work Details" },
    { key: "sponsorshipVisaRoute", label: "Sponsorship Visa Route", category: "Work Details" },
    { key: "accountHolderName", label: "Account Holder Name", category: "Bank Details" },
    { key: "bankName", label: "Bank Name", category: "Bank Details" },
    { key: "accountNumber", label: "Account Number", category: "Bank Details", sensitive: true },
    { key: "sortCode", label: "Sort Code", category: "Bank Details", sensitive: true },
    { key: "iban", label: "IBAN", category: "Bank Details", sensitive: true },
    { key: "passportNumber", label: "Passport Number", category: "Passport" },
    { key: "passportIssuingCountry", label: "Issuing Country", category: "Passport" },
    { key: "passportIssueDate", label: "Issue Date", category: "Passport" },
    { key: "passportExpiryDate", label: "Expiry Date", category: "Passport" },
    { key: "visaType", label: "Visa Type", category: "Visa" },
    { key: "visaNumber", label: "Visa Number", category: "Visa" },
    { key: "visaIssueDate", label: "Issue Date", category: "Visa" },
    { key: "visaExpiryDate", label: "Expiry Date", category: "Visa" },
    { key: "cosLicenceNumber", label: "Licence Number", category: "CoS" },
    { key: "cosSponsorName", label: "Sponsor Name", category: "CoS" },
    { key: "cosCertificateNumber", label: "Certificate Number", category: "CoS" },
    { key: "cosCertificateDate", label: "Certificate Date", category: "CoS" },
    { key: "cosAssignedDate", label: "Assigned Date", category: "CoS" },
    { key: "cosExpiryDate", label: "Expiry Date", category: "CoS" },
    { key: "cosApplyingFrom", label: "Applying From", category: "CoS" },
    { key: "cosType", label: "CoS Type", category: "CoS" },
    { key: "cosGenuineVacancyConfirmed", label: "Genuine Vacancy Confirmed", category: "CoS" },
    { key: "cosGenuineVacancyConfirmedDate", label: "Genuine Vacancy Confirmed Date", category: "CoS" },
    { key: "cosAssignedSalary", label: "CoS Assigned Salary", category: "CoS" },
    { key: "cosPayFrequency", label: "Pay Frequency", category: "CoS" },
    { key: "cosSponsorNote", label: "Remarks", category: "CoS" },
  ];

  /** Bank account/sort-code/IBAN/NI number are encrypted at rest for a
   * reason - writing their raw value into a plain-text audit log would
   * undo that. Masks down to the last 4 characters, same convention
   * already used elsewhere in the app for displaying a masked account
   * number. Non-sensitive fields pass through unchanged. */
  private maskIfSensitive(value: string | null, sensitive: boolean | undefined): string | null {
    if (!sensitive || value == null || value === "") return value;
    const visible = value.slice(-4);
    return `\u2022\u2022\u2022\u2022 ${visible}`;
  }

  /** Inserts one employee.employee_change_history row per field that
   * actually changed value (present in dto and different from
   * oldData) - called after a successful update() of an Active
   * record. Deliberately never throws: a history-logging failure
   * shouldn't roll back an otherwise-successful save. */
  private async logFieldChanges(
    client: PoolClient,
    tenantId: string,
    employeeId: string,
    oldData: EmployeeUpsertDto,
    dto: Partial<EmployeeUpsertDto>,
    changedBy: string | undefined
  ): Promise<void> {
    for (const field of this.TRACKABLE_FIELDS) {
      const newVal = dto[field.key];
      if (newVal === undefined) continue;
      const oldVal = oldData[field.key];
      if (String(oldVal ?? "") === String(newVal ?? "")) continue;
      // Numbers come back from the DB as "40.00" but the form sends "40" - the same value, not a change.
      if (field.key === "standardHoursPerWeek" && oldVal != null && oldVal !== "" && newVal != null && newVal !== "" && Number(oldVal) === Number(newVal)) continue;
      const oldStr = oldVal != null && oldVal !== "" ? String(oldVal) : null;
      const newStr = newVal != null && newVal !== "" ? String(newVal) : null;
      await client.query(
        `INSERT INTO employee.employee_change_history
           (tenant_id, employee_id, category, field_label, old_value, new_value, changed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, employeeId, field.category, field.label, this.maskIfSensitive(oldStr, field.sensitive), this.maskIfSensitive(newStr, field.sensitive), changedBy ?? null]
      );
    }
    await this.logArrayFieldChanges(client, tenantId, employeeId, oldData, dto, changedBy);
  }

  /** Item-level add/remove/change logging for the true repeatable
   * fields (emails, phones, addresses, education, certifications,
   * dependants, documents) - these can't be diffed as a single old/new
   * string the way TRACKABLE_FIELDS' scalar fields can, since the
   * "value" is a whole list of records. Matches items between the old
   * and new arrays by id: an id only in the new array is an addition,
   * only in the old array is a removal, present in both but with
   * different describe() output is a change. Right to Work checks are
   * deliberately not included here - RTW's own compliance-status
   * derivation already has its own history-equivalent surface (the
   * compliance timeline), and its fields don't map cleanly onto a
   * single-line description the way the others do. */
  private async logArrayFieldChanges(
    client: PoolClient,
    tenantId: string,
    employeeId: string,
    oldData: EmployeeUpsertDto,
    dto: Partial<EmployeeUpsertDto>,
    changedBy: string | undefined
  ): Promise<void> {
    const insert = async (category: string, fieldLabel: string, oldValue: string | null, newValue: string | null) => {
      await client.query(
        `INSERT INTO employee.employee_change_history
           (tenant_id, employee_id, category, field_label, old_value, new_value, changed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, employeeId, category, fieldLabel, oldValue, newValue, changedBy ?? null]
      );
    };

    async function diff<T extends { id?: string }>(
      category: string,
      label: string,
      oldArr: T[] | undefined,
      newArr: T[] | undefined,
      describe: (item: T) => string
    ) {
      if (newArr === undefined) return; // field not part of this save at all
      const oldById = new Map((oldArr ?? []).map((item) => [item.id, item]));
      const newById = new Map(newArr.map((item) => [item.id, item]));

      for (const [id, item] of newById) {
        if (!id || !oldById.has(id)) {
          await insert(category, `${label} added`, null, describe(item));
        }
      }
      for (const [id, item] of oldById) {
        if (!id || !newById.has(id)) {
          await insert(category, `${label} removed`, describe(item), null);
        }
      }
      for (const [id, newItem] of newById) {
        const oldItem = id ? oldById.get(id) : undefined;
        if (!oldItem) continue;
        const before = describe(oldItem);
        const after = describe(newItem);
        if (before !== after) await insert(category, `${label} updated`, before, after);
      }
    }

    await diff("Contact", "Email", oldData.emails, dto.emails, (e) => `${e.email || "\u2014"} (${e.type}${e.isPrimary ? ", primary" : ""})`);
    await diff("Contact", "Phone", oldData.phones, dto.phones, (p) => `${p.number || "\u2014"} (${p.type}${p.isPrimary ? ", primary" : ""})`);
    await diff("Contact", "Address", oldData.addresses, dto.addresses, (a) =>
      [a.line1, a.city, a.postcode].filter(Boolean).join(", ") + ` (${a.type}${a.isPrimary ? ", primary" : ""})`
    );
    await diff("Education & Certifications", "Education record", oldData.education, dto.education, (e) =>
      [e.qualification, e.institution, e.fieldOfStudy].filter(Boolean).join(" \u2013 ") || "\u2014"
    );
    await diff("Education & Certifications", "Certification", oldData.certifications, dto.certifications, (c) =>
      [c.name, c.issuingBody].filter(Boolean).join(" \u2013 ") || "\u2014"
    );
    await diff("Visa", "Dependant", oldData.dependants, dto.dependants, (d) =>
      [d.name, d.relationship].filter(Boolean).join(" \u2013 ") || "\u2014"
    );
    await diff("Documents", "Document", oldData.documents, dto.documents, (d) =>
      [d.fileName, d.documentType].filter(Boolean).join(" \u2013 ") || "\u2014"
    );
  }

  async update(tenantId: string, id: string, dto: Partial<EmployeeUpsertDto>, changedBy?: string): Promise<{ id: string }> {
    return withTenant(tenantId, async (client) => {
      const existing = await client.query(
        "SELECT id, record_status, employee_id_label FROM employee.employee_master WHERE id = $1 AND NOT is_deleted",
        [id]
      );
      if (!existing.rowCount) throw new NotFoundException("Employee not found.");
      const isDraft = existing.rows[0].record_status === "Draft";
      if (!isDraft && existing.rows[0].record_status !== "Active") {
        throw new BadRequestException(
          `This employee is ${existing.rows[0].record_status.toLowerCase()} and cannot be edited - reactivate the record first.`
        );
      }

      // Change-history, the SOC/Job-Title rule, and the mandatory-
      // evidence rule only apply to editing an already-Active record -
      // a Draft mid-wizard is filling fields in for the first time,
      // not "changing" anything meaningful to audit.
      let oldData: EmployeeUpsertDto | null = null;
      if (!isDraft) {
        oldData = await this.getByIdCore(client, tenantId, id);

        if (dto.jobTitle !== undefined && dto.jobTitle !== oldData.jobTitle) {
          const socAlsoChanging = dto.socNumber !== undefined && dto.socNumber !== oldData.socNumber;
          if (!socAlsoChanging) {
            throw new BadRequestException("SOC code must be updated to match the new Job Title.");
          }
        }

        const passportChanged =
          (dto.passportNumber !== undefined && dto.passportNumber !== oldData.passportNumber) ||
          (dto.passportExpiryDate !== undefined && dto.passportExpiryDate !== oldData.passportExpiryDate);
        const visaChanged =
          (dto.visaType !== undefined && dto.visaType !== oldData.visaType) ||
          (dto.visaNumber !== undefined && dto.visaNumber !== oldData.visaNumber) ||
          (dto.visaExpiryDate !== undefined && dto.visaExpiryDate !== oldData.visaExpiryDate);
        const cosChanged =
          (dto.cosCertificateNumber !== undefined && dto.cosCertificateNumber !== oldData.cosCertificateNumber) ||
          (dto.cosExpiryDate !== undefined && dto.cosExpiryDate !== oldData.cosExpiryDate);

        // Only a genuine *edit* of an already-populated section counts -
        // first-time entry into fields that were blank before this save
        // (typical for a record finalized without every section filled
        // in, e.g. one added straight into Employee Register) isn't
        // "changing" existing evidence, so it's exempt below regardless
        // of whether a document happens to exist yet.
        const passportHadValue = !!oldData.passportNumber?.trim() || !!oldData.passportExpiryDate?.trim();
        const visaHadValue = !!oldData.visaType?.trim() || !!oldData.visaNumber?.trim() || !!oldData.visaExpiryDate?.trim();
        const cosHadValue = !!oldData.cosCertificateNumber?.trim() || !!oldData.cosExpiryDate?.trim();

        // "New evidence" = a document of the matching type uploaded
        // since this record's own last save - not just any document
        // of that type ever on file, which could just be the old one.
        //
        // Was querying employee.employee_document, a table nothing in
        // this app writes to any more (it was the old wizard "Documents"
        // step's table, removed elsewhere as dead code) - this check
        // always found zero rows and blocked every Passport/Visa/CoS
        // change unconditionally, regardless of whether real evidence
        // had actually been uploaded through the working system. The
        // real uploads (Passport/Visa/CoS's own "Attach Document"
        // panels, via SupportingEvidencePanel) write to
        // compliance.supporting_document, tagged with the exact type
        // strings those panels pass as documentTypes - "Passport Scan",
        // "Visa Document", "CoS Attachment" - not the human-readable
        // labels used below for the error message.
        for (const [changed, hadValue, docType, uploadedDocumentType] of [
          [passportChanged, passportHadValue, "Passport", "Passport Scan"],
          [visaChanged, visaHadValue, "Visa", "Visa Document"],
          [cosChanged, cosHadValue, "Certificate of Sponsorship", "CoS Attachment"],
        ] as const) {
          if (!changed || !hadValue) continue;

          // No evidence of this type was ever attached in the first
          // place - nothing to require a fresher copy of, so this
          // change goes through without the check either.
          const existingDoc = await client.query(
            `SELECT 1 FROM compliance.supporting_document d
             WHERE d.employee_id = $1 AND d.document_type = $2 AND d.status != 'Failed' AND d.deleted_at IS NULL
             LIMIT 1`,
            [id, uploadedDocumentType]
          );
          if (!existingDoc.rowCount) continue;

          const recentDoc = await client.query(
            `SELECT 1 FROM compliance.supporting_document d
             WHERE d.employee_id = $1 AND d.document_type = $2 AND d.status != 'Failed' AND d.deleted_at IS NULL
               AND d.created_at > (SELECT updated_at FROM employee.employee_master WHERE id = $1)
             LIMIT 1`,
            [id, uploadedDocumentType]
          );
          if (!recentDoc.rowCount) {
            throw new BadRequestException(`New supporting evidence must be uploaded before saving a change to ${docType}.`);
          }
        }
      }

      const sets: string[] = [];
      const values: any[] = [];
      let i = 1;
      const set = (col: string, val: any) => { sets.push(`${col} = $${i++}`); values.push(val); };

      if (dto.firstName !== undefined) set("first_name", dto.firstName);
      if (dto.middleName !== undefined) set("middle_name", dto.middleName || null);
      if (dto.lastName !== undefined) set("last_name", dto.lastName);
      if (dto.dateOfBirth !== undefined) {
        if (!isDraft && !dto.dateOfBirth.trim()) throw new BadRequestException("Date of birth cannot be cleared - it's a required field.");
        set("date_of_birth", dto.dateOfBirth || null);
      }
      if (dto.gender !== undefined) set("gender", dto.gender || null);
      if (dto.maritalStatus !== undefined) set("marital_status", dto.maritalStatus || null);
      if (dto.isUkCitizen !== undefined) set("is_uk_citizen", dto.isUkCitizen !== "No");
      if (dto.isIlrSettled !== undefined) set("is_ilr_settled", dto.isIlrSettled === "Yes");
      if (dto.nationality !== undefined) set("nationality", dto.nationality || null);
      if (dto.nationalInsuranceNumber !== undefined) {
        set("ni_number_encrypted", await encrypt(client, dto.nationalInsuranceNumber));
        set("ni_number_hash", await hmacHash(client, dto.nationalInsuranceNumber));
      }
      if (dto.jobTitle !== undefined) set("job_title", dto.jobTitle);
      if (dto.department !== undefined) {
        if (!isDraft && !dto.department.trim()) throw new BadRequestException("Department cannot be cleared - it's a required field.");
        set("department_id", dto.department.trim() ? await this.resolveDepartmentId(client, tenantId, dto.department) : null);
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
      if (dto.contractEndDate !== undefined) set("contract_end_date", dto.contractEndDate || null);
      if (dto.currentLocation !== undefined) set("current_location", dto.currentLocation || null);
      if (dto.currentImmigrationStatus !== undefined) set("current_immigration_status", dto.currentImmigrationStatus || null);
      if (dto.rtwEngagementType !== undefined) set("rtw_engagement_type", dto.rtwEngagementType || null);
      if (dto.proposedAnnualSalary !== undefined) set("proposed_annual_salary", dto.proposedAnnualSalary ? Number(dto.proposedAnnualSalary) : null);
      if (dto.salaryOffered !== undefined) set("salary_offered", dto.salaryOffered || null);
      if (dto.guaranteedBasicGrossPay !== undefined) set("guaranteed_basic_gross_pay", dto.guaranteedBasicGrossPay || null);
      if (dto.projectWorkBranch !== undefined) set("project_work_branch", dto.projectWorkBranch || null);
      if (dto.sponsoredEmployee !== undefined) set("sponsored_employee", dto.sponsoredEmployee === "Yes");
      if (dto.sponsorshipVisaRoute !== undefined) set("sponsorship_visa_route", dto.sponsorshipVisaRoute || null);
      // employee_id_label is intentionally not settable here either -
      // generated once (either on create() for a direct Employee
      // Register add, or on onboardEmployee() for a candidate being
      // onboarded), never editable afterwards.
      // candidate_id_label is intentionally not settable here - it's
      // generated once on create() and never changes afterwards.
      if (dto.jobContractFileName !== undefined) set("job_contract_file_reference", dto.jobContractFileName);
      if (dto.startDate !== undefined) {
        // Only "required" once it's actually been set - Candidate
        // Onboarding never populates startDate at all (it uses
        // proposedJoiningDate instead, see that field's own comment),
        // so oldData.startDate is always blank there; without this
        // guard, saving any step of an Active candidate's record sent
        // startDate: "" right back and tripped this unconditionally.
        // Employee Register still can't blank it out again once a real
        // Actual Joining date has been recorded.
        if (!isDraft && !dto.startDate.trim() && oldData.startDate?.trim()) {
          throw new BadRequestException("Start date cannot be cleared - it's a required field.");
        }
        set("date_of_joining", dto.startDate || null);
      }
      if (dto.proposedJoiningDate !== undefined) set("proposed_joining_date", dto.proposedJoiningDate || null);
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

      // A directly-added employee (Employee Register's "Add Employee",
      // not a Candidate Onboarding wizard still mid-flow) held back at
      // Draft by finalize() below because Pre-Hire Compliance wasn't
      // done yet - promote to Active the moment it is. RTW is the only
      // pre-employment check type with real persisted state today (see
      // PreEmploymentChecksTab's own comment on the others), so "done"
      // means at least one RTW check now on file.
      if (isDraft && existing.rows[0].employee_id_label) {
        const rtwExists = await client.query(
          "SELECT 1 FROM employee.employee_rtw_check WHERE employee_id = $1 LIMIT 1",
          [id]
        );
        if (rtwExists.rowCount) {
          await client.query(
            "UPDATE employee.employee_master SET record_status='Active', updated_at=now() WHERE id=$1",
            [id]
          );
        }
      }

      if (!isDraft && oldData) {
        await this.logFieldChanges(client, tenantId, id, oldData, dto, changedBy);
      }

      return { id };
    });
  }

  /** The self-service counterpart to update() - an employee editing
   * their own record. Deliberately does NOT touch employee_master at
   * all: captures a diff against the current record as a pending
   * request instead, which only takes effect once an HR Admin approves
   * it (decideChangeRequest below, which calls this same update()
   * method to actually apply it - so approval gets every existing
   * business rule, such as the SOC/Job-Title coupling and the
   * mandatory-evidence rule, for free rather than re-implementing them
   * here).
   *
   * Deliberately scoped to TRACKABLE_FIELDS' scalar/single-row fields
   * only for this first version - the true repeatable arrays (emails,
   * phones, addresses, education, certifications, dependants,
   * documents) need their own item-level approve/reject UX to be
   * genuinely useful (approving "add one phone number" shouldn't force
   * approving an unrelated address edit bundled into the same array),
   * which is a larger, separate piece of work. An employee's Edit
   * wizard can still be opened and those sections viewed; submitting a
   * change to one is out of scope for this iteration and should be
   * caught by the frontend before it reaches here.
   */
  async submitChangeRequest(
    tenantId: string,
    employeeId: string,
    dto: Partial<EmployeeUpsertDto>,
    requestedBy: string | undefined
  ): Promise<{ id: string; pending: true } | { id: string; pending: false }> {
    return withTenant(tenantId, async (client) => {
      const existing = await client.query(
        "SELECT id, record_status FROM employee.employee_master WHERE id = $1 AND NOT is_deleted",
        [employeeId]
      );
      if (!existing.rowCount) throw new NotFoundException("Employee not found.");
      if (existing.rows[0].record_status !== "Active") {
        throw new BadRequestException("Your record isn't currently active - contact HR.");
      }

      const oldData = await this.getByIdCore(client, tenantId, employeeId);

      const items: { key: keyof EmployeeUpsertDto; label: string; category: string; oldValue: string | null; newValue: string | null }[] = [];
      for (const field of this.TRACKABLE_FIELDS) {
        const newVal = dto[field.key];
        if (newVal === undefined) continue;
        const oldVal = oldData[field.key];
        if (String(oldVal ?? "") === String(newVal ?? "")) continue;
        items.push({
          key: field.key,
          label: field.label,
          category: field.category,
          oldValue: oldVal != null && oldVal !== "" ? String(oldVal) : null,
          newValue: newVal != null && newVal !== "" ? String(newVal) : null,
        });
      }

      if (items.length === 0) {
        // Nothing actually changed (or only array fields were touched,
        // which this endpoint doesn't accept) - nothing to submit.
        return { id: employeeId, pending: false };
      }

      const header = await client.query(
        `INSERT INTO employee.employee_change_request (tenant_id, employee_id, requested_by)
         VALUES ($1, $2, $3) RETURNING id`,
        [tenantId, employeeId, requestedBy ?? null]
      );
      const requestId = header.rows[0].id;

      for (const item of items) {
        await client.query(
          `INSERT INTO employee.employee_change_request_item
             (request_id, category, field_key, field_label, old_value, new_value)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [requestId, item.category, item.key, item.label, item.oldValue, item.newValue]
        );
      }

      return { id: requestId, pending: true };
    });
  }

  /** For the Workflow page's list view. */
  async listChangeRequests(tenantId: string, status?: string): Promise<any[]> {
    const result = await withTenant(tenantId, async (client) => {
      return client.query(
        `SELECT r.id, r.employee_id, r.status, r.requested_by, r.requested_at, r.reviewed_by, r.reviewed_at, r.review_note,
                m.first_name, m.middle_name, m.last_name, m.employee_id_label,
                (SELECT COUNT(*) FROM employee.employee_change_request_item i WHERE i.request_id = r.id) AS field_count
         FROM employee.employee_change_request r
         JOIN employee.employee_master m ON m.id = r.employee_id
         WHERE r.tenant_id = $1 ${status ? "AND r.status = $2" : ""}
         ORDER BY r.requested_at DESC`,
        status ? [tenantId, status] : [tenantId]
      );
    });
    return result.rows.map((r) => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(" "),
      employeeNumber: r.employee_id_label,
      status: r.status,
      requestedBy: r.requested_by,
      requestedAt: r.requested_at,
      reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at,
      reviewNote: r.review_note,
      fieldCount: Number(r.field_count),
    }));
  }

  /** Full field-level detail for one request, for the Workflow page's
   * approve/reject detail view. */
  async getChangeRequest(tenantId: string, requestId: string): Promise<any> {
    const result = await withTenant(tenantId, async (client) => {
      return client.query(
        `SELECT r.id, r.employee_id, r.status, r.requested_by, r.requested_at, r.reviewed_by, r.reviewed_at, r.review_note,
                m.first_name, m.middle_name, m.last_name, m.employee_id_label
         FROM employee.employee_change_request r
         JOIN employee.employee_master m ON m.id = r.employee_id
         WHERE r.tenant_id = $1 AND r.id = $2`,
        [tenantId, requestId]
      );
    });
    if (!result.rowCount) throw new NotFoundException("Change request not found.");
    const r = result.rows[0];

    const items = await withTenant(tenantId, async (client) => {
      return client.query(
        `SELECT category, field_key, field_label, old_value, new_value
         FROM employee.employee_change_request_item WHERE request_id = $1 ORDER BY category, field_label`,
        [requestId]
      );
    });

    return {
      id: r.id,
      employeeId: r.employee_id,
      employeeName: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(" "),
      employeeNumber: r.employee_id_label,
      status: r.status,
      requestedBy: r.requested_by,
      requestedAt: r.requested_at,
      reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at,
      reviewNote: r.review_note,
      items: items.rows.map((i) => ({
        category: i.category,
        fieldKey: i.field_key,
        fieldLabel: i.field_label,
        oldValue: i.old_value,
        newValue: i.new_value,
      })),
    };
  }

  /** Approving replays the request's items through the exact same
   * update() an HR Admin's own direct edit would go through - same
   * validation, same history logging (changedBy records the reviewer,
   * with a note that this originated from the employee's own request,
   * so History doesn't misrepresent who typed the original value).
   * Rejecting just marks the request closed; employee_master is never
   * touched. Either way the request moves out of "Pending" and off the
   * Workflow page's default list. */
  async decideChangeRequest(
    tenantId: string,
    requestId: string,
    decision: "Approved" | "Rejected",
    reviewedBy: string | undefined,
    note: string | undefined
  ): Promise<{ id: string }> {
    const detail = await this.getChangeRequest(tenantId, requestId);
    if (detail.status !== "Pending") {
      throw new BadRequestException(`This request has already been ${detail.status.toLowerCase()}.`);
    }

    if (decision === "Approved") {
      const dto: Partial<EmployeeUpsertDto> = {};
      for (const item of detail.items) {
        (dto as any)[item.fieldKey] = item.newValue ?? "";
      }
      await this.update(tenantId, detail.employeeId, dto, `${reviewedBy ?? "HR"} (approved employee request)`);
    }

    await withTenant(tenantId, async (client) => {
      return client.query(
        `UPDATE employee.employee_change_request
         SET status = $1, reviewed_by = $2, reviewed_at = now(), review_note = $3
         WHERE id = $4 AND tenant_id = $5`,
        [decision, reviewedBy ?? null, note ?? null, requestId, tenantId]
      );
    });

    return { id: requestId };
  }

  /** Live UKVI reporting events across every Active sponsored
   * employee/candidate, one record per event, under five scenarios
   * (see UKVI_SCENARIOS on the front-end). Deadline is 10 working days
   * from the event. There's no stored "already reported" flag yet, so
   * nothing is ever "Reported", and change-based events (role/location)
   * only look back CHANGE_LOOKBACK_DAYS so old changes don't sit
   * Overdue forever. */
  async listUkviActions(tenantId: string) {
    const ABSENCE_THRESHOLD = 10;
    const NO_SHOW_DAYS = 28;
    const CHANGE_LOOKBACK_DAYS = 60;
    const SCENARIOS = {
      absence: "Worker absent from work without permission for more than 10 consecutive working days",
      noShow: "CoS Assigned - Employee fails to start (no show)",
      pay: "Worker's salary or pay drops below the level stated on their CoS",
      role: "Significant change to job role, title, core duties, or a promotion",
      location: "Worker's normal work location changes from what is recorded on the CoS",
    };
    return withTenant(tenantId, async (client) => {
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      const num = (v: unknown) => {
        const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
        return String(v ?? "").trim() && Number.isFinite(n) ? n : null;
      };

      const [emps, att, hol, hist] = await Promise.all([
        client.query(
          `SELECT m.id, m.first_name, m.middle_name, m.last_name, m.job_title, m.is_onboarded, m.date_of_joining,
                  m.salary_offered, d.name AS department_name, c.assigned_date, c.cos_assigned_salary
           FROM employee.employee_master m
           LEFT JOIN reference.department d ON d.id = m.department_id
           LEFT JOIN employee.employee_cos_detail c ON c.employee_id = m.id
           WHERE NOT m.is_deleted AND m.record_status = 'Active' AND m.sponsored_employee = true`
        ),
        client.query("SELECT employee_id, record_date, status FROM attendance.attendance_record"),
        client.query("SELECT holiday_date FROM reference.holiday"),
        client.query(
          `SELECT employee_id, field_label, old_value, new_value, changed_at FROM employee.employee_change_history
           WHERE field_label = ANY($1) AND changed_at >= now() - ($2 || ' days')::interval ORDER BY changed_at`,
          [["Job Title", "Job Description", "Department", "SOC Number", "Work Location", "Work Timing", "Project / Work / Branch", "Weekly Working Hours", "Salary Offered", "CoS Assigned Salary"], String(CHANGE_LOOKBACK_DAYS)]
        ),
      ]);

      const holidays = new Set(hol.rows.map((r) => toDateStr(r.holiday_date)));
      const isWorkingDay = (d: Date) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !holidays.has(iso(d));
      const addWorkingDays = (from: string, n: number) => {
        const d = new Date(from + "T00:00:00Z");
        let left = n;
        while (left > 0) {
          d.setUTCDate(d.getUTCDate() + 1);
          if (isWorkingDay(d)) left -= 1;
        }
        return iso(d);
      };
      const today = iso(new Date());
      const todayMs = new Date(today + "T00:00:00Z").getTime();

      const attByEmp = new Map<string, Map<string, string>>();
      for (const r of att.rows) {
        if (!attByEmp.has(r.employee_id)) attByEmp.set(r.employee_id, new Map());
        attByEmp.get(r.employee_id)!.set(toDateStr(r.record_date), r.status);
      }
      const histByEmp = new Map<string, { label: string; at: string; oldValue: string | null; newValue: string | null }[]>();
      for (const r of hist.rows) {
        if (!histByEmp.has(r.employee_id)) histByEmp.set(r.employee_id, []);
        histByEmp.get(r.employee_id)!.push({ label: r.field_label, at: new Date(r.changed_at).toISOString().slice(0, 10), oldValue: r.old_value ?? null, newValue: r.new_value ?? null });
      }

      const records: {
        id: string; recordId: string; isOnboarded: boolean; employeeName: string; department: string; jobTitle: string;
        scenario: string; eventDate: string; reportingDeadline: string; status: "Overdue" | "Due Soon"; daysLeft: number;
        changes?: { field: string; previous: string | null; current: string | null }[];
        extras?: { label: string; value: string }[];
      }[] = [];

      for (const e of emps.rows) {
        const base = {
          recordId: e.id as string,
          isOnboarded: !!e.is_onboarded,
          employeeName: [e.first_name, e.middle_name, e.last_name].filter(Boolean).join(" "),
          department: (e.department_name ?? "") as string,
          jobTitle: (e.job_title ?? "") as string,
        };
        const push = (scenario: string, eventDate: string, key: string, extra?: { changes?: { field: string; previous: string | null; current: string | null }[]; extras?: { label: string; value: string }[] }) => {
          const reportingDeadline = addWorkingDays(eventDate, 10);
          const daysLeft = Math.round((new Date(reportingDeadline + "T00:00:00Z").getTime() - todayMs) / 86400000);
          records.push({ ...base, id: `${e.id}:${key}`, scenario, eventDate, reportingDeadline, status: daysLeft < 0 ? "Overdue" : "Due Soon", daysLeft, ...extra });
        };

        // 1. consecutive unauthorised working days
        const joining = e.date_of_joining ? toDateStr(e.date_of_joining) : null;
        if (joining && joining <= today) {
          const status = attByEmp.get(e.id) ?? new Map<string, string>();
          let run = 0;
          let runStart = "";
          let flagged = false;
          for (let d = new Date(joining + "T00:00:00Z"); iso(d) <= today; d.setUTCDate(d.getUTCDate() + 1)) {
            if (!isWorkingDay(d)) continue;
            const st = status.get(iso(d));
            if (!st || st === "absent") {
              if (run === 0) { runStart = iso(d); flagged = false; }
              run += 1;
              if (run === ABSENCE_THRESHOLD + 1 && !flagged) { push(SCENARIOS.absence, iso(d), `absence:${runStart}`); flagged = true; }
            } else {
              run = 0;
            }
          }
        }

        // 2. CoS assigned, not started
        const assigned = e.assigned_date ? toDateStr(e.assigned_date) : null;
        if (assigned && (!joining || joining > today)) {
          const event = iso(new Date(new Date(assigned + "T00:00:00Z").getTime() + NO_SHOW_DAYS * 86400000));
          if (event <= today) push(SCENARIOS.noShow, event, "noshow");
        }

        // 3. salary below CoS salary
        const salary = num(e.salary_offered);
        const cosSalary = num(e.cos_assigned_salary);
        const changes = histByEmp.get(e.id) ?? [];
        if (salary !== null && cosSalary !== null && salary < cosSalary) {
          const salaryChanges = changes.filter((c) => c.label === "Salary Offered");
          const lastSalary = salaryChanges[salaryChanges.length - 1];
          const payDates = changes.filter((c) => c.label === "Salary Offered" || c.label === "CoS Assigned Salary").map((c) => c.at).sort();
          push(SCENARIOS.pay, payDates.length ? payDates[payDates.length - 1] : today, "pay", {
            changes: [{ field: "Salary", previous: lastSalary?.oldValue ?? null, current: String(e.salary_offered ?? "") || null }],
            extras: [{ label: "CoS Salary", value: String(e.cos_assigned_salary ?? "").trim() || "-" }],
          });
        }

        // 4/5. role and location changes (one event per change date, listing every field changed that day)
        const byKey = new Map<string, { kind: "role" | "location"; at: string; items: { field: string; previous: string | null; current: string | null }[] }>();
        for (const c of changes) {
          const kind = ["Job Title", "Job Description", "Department", "SOC Number"].includes(c.label) ? "role"
            : ["Work Location", "Work Timing", "Project / Work / Branch", "Weekly Working Hours"].includes(c.label) ? "location" : null;
          if (!kind) continue;
          const key = kind + c.at;
          if (!byKey.has(key)) byKey.set(key, { kind, at: c.at, items: [] });
          byKey.get(key)!.items.push({ field: c.label, previous: c.oldValue, current: c.newValue });
        }
        // Collapse each field to its first-previous and last-current value, and drop changes that
        // are only formatting (e.g. "40.00" -> "40") or that were reverted the same day.
        const same = (x: string | null, y: string | null) => {
          const nx = (x ?? "").trim();
          const ny = (y ?? "").trim();
          if (nx === ny) return true;
          const fx = Number(nx.replace(/,/g, ""));
          const fy = Number(ny.replace(/,/g, ""));
          return nx !== "" && ny !== "" && Number.isFinite(fx) && Number.isFinite(fy) && fx === fy;
        };
        for (const v of byKey.values()) {
          const perField = new Map<string, { field: string; previous: string | null; current: string | null }>();
          for (const it of v.items) {
            const existing = perField.get(it.field);
            if (existing) existing.current = it.current;
            else perField.set(it.field, { ...it });
          }
          const real = [...perField.values()].filter((it) => !same(it.previous, it.current));
          if (real.length === 0) continue;
          push(v.kind === "role" ? SCENARIOS.role : SCENARIOS.location, v.at, `${v.kind}:${v.at}`, { changes: real });
        }
      }

      return records.sort((a, b) => a.reportingDeadline.localeCompare(b.reportingDeadline));
    });
  }

  /** Auto-computed status text for three Sponsor Employee Compliance
   * checkpoints (see EmployeeComplianceChecklist). Each result is
   * { flagged, text } - flagged=true means the checkpoint has been
   * triggered. Absence: a working day (Mon-Fri, not a reference.holiday,
   * on/after joining, up to today) with no attendance entry, or an
   * 'absent' one, counts as unauthorised - present/remote/leave/
   * sick-leave do not. Salary: employee_master.salary_offered vs the
   * CoS's own cos_assigned_salary. Role: Work Details history rows for
   * job title/description/department/SOC. */
  async getSponsorComplianceChecks(tenantId: string, employeeId: string) {
    return withTenant(tenantId, async (client) => {
      const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
      const pretty = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
      const num = (v: unknown) => {
        const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
        return String(v ?? "").trim() && Number.isFinite(n) ? n : null;
      };

      const [emp, cos, att, hol, hist, rtwRows, locHist] = await Promise.all([
        client.query("SELECT date_of_joining, salary_offered FROM employee.employee_master WHERE id = $1", [employeeId]),
        client.query("SELECT cos_assigned_salary, cos_pay_frequency FROM employee.employee_cos_detail WHERE employee_id = $1", [employeeId]),
        client.query("SELECT record_date, status FROM attendance.attendance_record WHERE employee_id = $1", [employeeId]),
        client.query("SELECT holiday_date FROM reference.holiday"),
        client.query(
          `SELECT field_label, old_value, new_value, changed_at FROM employee.employee_change_history
           WHERE employee_id = $1 AND field_label = ANY($2) ORDER BY changed_at DESC`,
          [employeeId, ["Job Title", "Job Description", "Department", "SOC Number"]]
        ),
        client.query(
          `SELECT check_method, date_of_check, checked_by_name, status, expiry_date, rtw_reference, share_code
           FROM employee.employee_rtw_check WHERE employee_id = $1 ORDER BY date_of_check DESC NULLS LAST`,
          [employeeId]
        ),
        client.query(
          `SELECT field_label, old_value, new_value, changed_at FROM employee.employee_change_history
           WHERE employee_id = $1 AND field_label = ANY($2) ORDER BY changed_at DESC`,
          [employeeId, ["Work Location", "Work Timing", "Project / Work / Branch", "Weekly Working Hours"]]
        ),
      ]);
      const e = emp.rows[0];
      if (!e) throw new NotFoundException("Employee not found.");

      // A) consecutive unauthorised working days
      const joining = e.date_of_joining ? toDateStr(e.date_of_joining) : null;
      let absence: { flagged: boolean; text: string };
      if (!joining) {
        absence = { flagged: false, text: "Joining date not recorded - attendance can't be assessed." };
      } else {
        const holidays = new Set(hol.rows.map((r) => toDateStr(r.holiday_date)));
        const status = new Map(att.rows.map((r) => [toDateStr(r.record_date), r.status as string]));
        const runs: { from: string; to: string; days: number }[] = [];
        let run: { from: string; to: string; days: number } | null = null;
        const today = fmtDate(new Date());
        for (let d = new Date(joining + "T00:00:00Z"); fmtDate(d) <= today; d.setUTCDate(d.getUTCDate() + 1)) {
          const iso = fmtDate(d);
          const dow = d.getUTCDay();
          if (dow === 0 || dow === 6 || holidays.has(iso)) continue;
          const st = status.get(iso);
          if (!st || st === "absent") {
            if (run) { run.to = iso; run.days += 1; } else { run = { from: iso, to: iso, days: 1 }; }
          } else if (run) {
            runs.push(run); run = null;
          }
        }
        if (run) runs.push(run);
        const flaggedRuns = runs.filter((r) => r.days > 10);
        absence = flaggedRuns.length
          ? { flagged: true, text: flaggedRuns.map((r) => `${r.days} consecutive working days with no attendance/timesheet entry (${pretty(r.from)} - ${pretty(r.to)})`).join("; ") }
          : { flagged: false, text: "No period of more than 10 consecutive working days without attendance/timesheet entries." };
      }

      // B) salary vs CoS salary
      const salary = num(e.salary_offered);
      const cosSalary = num(cos.rows[0]?.cos_assigned_salary);
      let pay: { flagged: boolean; text: string };
      if (salary === null || cosSalary === null) {
        pay = { flagged: false, text: salary === null ? "Employee salary not recorded." : "CoS assigned salary has not been entered yet - add it in the CoS section of the employee profile." };
      } else if (salary < cosSalary) {
        pay = { flagged: true, text: `Salary (${salary.toLocaleString("en-GB")}) is below the CoS salary (${cosSalary.toLocaleString("en-GB")}).` };
      } else {
        pay = { flagged: false, text: `Salary (${salary.toLocaleString("en-GB")}) is at or above the CoS salary (${cosSalary.toLocaleString("en-GB")}).` };
      }

      // C) role changes
      const role = hist.rows.length
        ? {
            flagged: true,
            text: hist.rows
              .map((r) => `${r.field_label} changed from "${r.old_value || "-"}" to "${r.new_value || "-"}" on ${pretty(new Date(r.changed_at).toISOString())}`)
              .join("; "),
          }
        : { flagged: false, text: "No changes to job title, description, department or SOC recorded." };

      // D) right to work summary (latest check)
      let rtw: { flagged: boolean; text: string };
      if (!rtwRows.rows.length) {
        rtw = { flagged: true, text: "No right to work check recorded." };
      } else {
        const l = rtwRows.rows[0];
        const checked = l.date_of_check ? toDateStr(l.date_of_check) : null;
        const late = !!(checked && joining && checked > joining);
        const parts = [
          `Latest check: ${l.check_method || "method not recorded"}${checked ? ` on ${pretty(checked)}` : ""}${l.checked_by_name ? ` by ${l.checked_by_name}` : ""}`,
          `Status: ${l.status || "-"}`,
          l.expiry_date ? `Expires ${pretty(toDateStr(l.expiry_date))}` : null,
          l.rtw_reference ? `Ref ${l.rtw_reference}` : l.share_code ? `Share code ${l.share_code}` : null,
          `${rtwRows.rows.length} check(s) on file`,
          late ? "Check was carried out after the joining date" : null,
        ].filter(Boolean);
        rtw = { flagged: late, text: parts.join(" | ") };
      }

      // E) work location / timing changes
      const location = locHist.rows.length
        ? {
            flagged: true,
            text: locHist.rows
              .map((r) => `${r.field_label} changed from "${r.old_value || "-"}" to "${r.new_value || "-"}" on ${pretty(new Date(r.changed_at).toISOString())}`)
              .join("; "),
          }
        : { flagged: false, text: "No changes to work location or work timing recorded." };

      return { absence, pay, role, rtw, location };
    });
  }

  /** Chronological (most recent first) change history for the History
   * tab - every field-level change recorded by logFieldChanges above. */
  async listChangeHistory(tenantId: string, employeeId: string): Promise<{
    id: string; category: string; fieldLabel: string; oldValue: string | null; newValue: string | null;
    changedAt: string; changedBy: string | null; evidenceFileReference: string | null;
  }[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, category, field_label, old_value, new_value, changed_at, changed_by, evidence_file_reference
         FROM employee.employee_change_history
         WHERE employee_id = $1
         ORDER BY changed_at DESC`,
        [employeeId]
      );
      return result.rows.map((r) => ({
        id: r.id,
        category: r.category,
        fieldLabel: r.field_label,
        oldValue: r.old_value,
        newValue: r.new_value,
        changedAt: r.changed_at.toISOString(),
        changedBy: r.changed_by,
        evidenceFileReference: r.evidence_file_reference,
      }));
    });
  }

  /** Field-level view of every currently-Pending change request against
   * this employee, keyed by field_key - drives the Profile tab's
   * per-field "old value, pending approval" display (both the HR
   * Admin's own view of the record and the employee's view of their
   * own record use the same endpoint, gated the same way GET :id is).
   * A field can only ever have one outstanding value here: nothing else
   * lets a second request be submitted while one is already Pending, so
   * there's no ordering concern the way listChangeHistory has to think
   * about (most-recent-first) for a field with several historical
   * entries. employee_master itself is never touched by a Pending
   * request, so the value the UI is already showing for each field
   * *is* the old value - this only needs to add what's pending on top
   * of it, not re-fetch or duplicate the current record. */
  async getPendingFieldChanges(tenantId: string, employeeId: string): Promise<Record<string, {
    requestId: string; category: string; fieldLabel: string; oldValue: string | null; newValue: string | null; requestedBy: string | null; requestedAt: string;
  }>> {
    const result = await withTenant(tenantId, async (client) => {
      return client.query(
        `SELECT i.field_key, i.category, i.field_label, i.old_value, i.new_value,
                r.id AS request_id, r.requested_by, r.requested_at
         FROM employee.employee_change_request_item i
         JOIN employee.employee_change_request r ON r.id = i.request_id
         WHERE r.tenant_id = $1 AND r.employee_id = $2 AND r.status = 'Pending'
         ORDER BY r.requested_at DESC`,
        [tenantId, employeeId]
      );
    });
    const byField: Record<string, {
      requestId: string; category: string; fieldLabel: string; oldValue: string | null; newValue: string | null; requestedBy: string | null; requestedAt: string;
    }> = {};
    for (const r of result.rows) {
      // Most-recent-first ordering means the first row seen per
      // field_key wins if, for some reason, more than one Pending
      // request ever touched the same field.
      if (byField[r.field_key]) continue;
      byField[r.field_key] = {
        requestId: r.request_id,
        category: r.category,
        fieldLabel: r.field_label,
        oldValue: r.old_value,
        newValue: r.new_value,
        requestedBy: r.requested_by,
        requestedAt: r.requested_at.toISOString(),
      };
    }
    return byField;
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

  /** Employee Onboarding's "Onboard Employee" action - the one-way
   * transition from "candidate in the pre-hire pipeline" to "employee
   * in Employee Register". Deliberately one-way (no un-onboard here):
   * reversing it is a status/record-correction concern, not something
   * this action needs to support. Also where Employee Number
   * (employee_id_label, E000001...) is generated - it doesn't exist
   * before this point, matching how Candidate ID is generated once on
   * create() rather than editable at any point. */
  /** Not safe to call twice with different outcomes each time -
   * without this check, a second call (a fast double-click, a retried
   * request) would mint a brand-new employee_id_label via
   * nextSequenceNumber and overwrite the real one, and since the
   * login email is built from that label, it would also silently
   * leave behind an orphaned credential under the old email that no
   * longer matches anything. So this is idempotent: once
   * is_onboarded is true, every further call just returns the
   * existing state - no new sequence number, no second credential
   * provisioning attempt. `FOR UPDATE` closes the race where two
   * concurrent onboard calls both read is_onboarded=false before
   * either has written true. */
  async onboardEmployee(tenantId: string, id: string): Promise<{ id: string; isOnboarded: boolean; employeeId: string }> {
    const result = await withTenant(tenantId, async (client) => {
      const existing = await client.query(
        "SELECT is_onboarded, employee_id_label FROM employee.employee_master WHERE id = $1 AND NOT is_deleted FOR UPDATE",
        [id]
      );
      if (!existing.rowCount) throw new NotFoundException("Employee not found.");
      if (existing.rows[0].is_onboarded) {
        return {
          id,
          isOnboarded: true,
          employeeId: existing.rows[0].employee_id_label,
          emailDomain: null, // already provisioned (or deliberately not) - see comment above, this call never (re-)provisions.
        };
      }

      const employeeIdLabel = await nextSequenceNumber(client, tenantId, "employee_number", "E", 6);
      const updateRes = await client.query(
        "UPDATE employee.employee_master SET is_onboarded = true, employee_id_label = $1, updated_at = now() WHERE id = $2 AND NOT is_deleted RETURNING id, is_onboarded, employee_id_label",
        [employeeIdLabel, id]
      );
      if (!updateRes.rowCount) throw new NotFoundException("Employee not found.");

      const employerRes = await client.query(
        "SELECT email_domain FROM reference.employer_profile WHERE tenant_id = $1",
        [tenantId]
      );
      const emailDomain: string | null = employerRes.rows[0]?.email_domain || null;

      return {
        id: updateRes.rows[0].id,
        isOnboarded: updateRes.rows[0].is_onboarded,
        employeeId: updateRes.rows[0].employee_id_label,
        emailDomain,
      };
    });

    // Credential provisioning happens after the transaction commits,
    // against security.credential via AuthService's own connection -
    // that table lives outside employee.employee_master's tenant-RLS
    // transaction entirely (see Database Design - Common Platform
    // Standards, Section 4.6), so it's a genuinely separate write, not
    // part of the same atomic unit. If Employer Settings hasn't had an
    // email domain configured yet, onboarding still succeeds - the
    // employee just doesn't get a login credential, and (per the
    // idempotency guard above) simply calling onboard again is NOT how
    // to fix that after the fact - a dedicated "create login for this
    // employee" action is needed for that case, out of scope here.
    if (result.emailDomain) {
      const email = `${result.employeeId}@${result.emailDomain}`;
      await this.authService.createEmployeeCredential(tenantId, result.id, email, result.employeeId);
    }

    return { id: result.id, isOnboarded: result.isOnboarded, employeeId: result.employeeId };
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
        `INSERT INTO employee.employee_cos_detail (tenant_id, employee_id, licence_number, sponsor_name, certificate_number, certificate_date, assigned_date, expiry_date, applying_from, cos_type, genuine_vacancy_confirmed, genuine_vacancy_confirmed_date, sponsor_note, file_reference, cos_assigned_salary, cos_pay_frequency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (employee_id) DO UPDATE SET
           licence_number = EXCLUDED.licence_number, sponsor_name = EXCLUDED.sponsor_name,
           certificate_number = EXCLUDED.certificate_number, certificate_date = EXCLUDED.certificate_date,
           assigned_date = EXCLUDED.assigned_date, expiry_date = EXCLUDED.expiry_date,
           applying_from = EXCLUDED.applying_from, cos_type = EXCLUDED.cos_type,
           genuine_vacancy_confirmed = EXCLUDED.genuine_vacancy_confirmed,
           genuine_vacancy_confirmed_date = EXCLUDED.genuine_vacancy_confirmed_date,
           sponsor_note = EXCLUDED.sponsor_note, file_reference = EXCLUDED.file_reference,
           cos_assigned_salary = EXCLUDED.cos_assigned_salary, cos_pay_frequency = EXCLUDED.cos_pay_frequency`,
        [tenantId, employeeId, dto.cosLicenceNumber || null, dto.cosSponsorName || null, dto.cosCertificateNumber || null, dto.cosCertificateDate || null, dto.cosAssignedDate || null, dto.cosExpiryDate || null, dto.cosApplyingFrom || null, dto.cosType || null, dto.cosGenuineVacancyConfirmed || null, dto.cosGenuineVacancyConfirmedDate || null, dto.cosSponsorNote || null, dto.cosFileName || null, dto.cosAssignedSalary || null, dto.cosPayFrequency || null]
      );
    }

    if (dto.rtwChecks) {
      await client.query("DELETE FROM employee.employee_rtw_check WHERE employee_id = $1", [employeeId]);
      for (const r of dto.rtwChecks) {
        await client.query(
          `INSERT INTO employee.employee_rtw_check
             (tenant_id, employee_id, check_method, document_evidence_type, document_type, document_expiry_date,
              pvn_date, share_code, rtw_reference, online_code_issued_date, online_permission_limit,
              online_expiry_date, idsp_provider, checked_by_name, checked_by_role, date_of_check,
              photo_match_confirmed, known_reasonable_cause_flag, statutory_excuse_established, status,
              expiry_date, remarks, attachment_file_reference)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
          [
            tenantId, employeeId, r.checkMethod || null, r.documentEvidenceType || null,
            r.documentType || null, r.documentExpiryDate || null,
            r.pvnDate || null, r.shareCode || null, r.rtwReference || null,
            r.onlineCodeIssuedDate || null, r.onlinePermissionLimit || null,
            r.onlineExpiryDate || null, r.idspProvider || null,
            r.checkedByName || null, r.checkedByRole || null,
            r.dateOfCheck || null, !!r.photoMatchConfirmed, !!r.knownReasonableCauseFlag,
            r.statutoryExcuseEstablished || null, r.status || null,
            r.expiryDate || null, r.remarks || null, r.attachmentFileName || null,
          ]
        );
      }
    }

    if (dto.dependants) {
      await client.query("DELETE FROM employee.employee_dependant WHERE employee_id = $1", [employeeId]);
      for (const dep of dto.dependants) {
        await client.query(
          `INSERT INTO employee.employee_dependant (tenant_id, employee_id, name, relationship, date_of_birth)
           VALUES ($1,$2,$3,$4,$5)`,
          [tenantId, employeeId, dep.name || null, dep.relationship || null, dep.dateOfBirth || null]
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
