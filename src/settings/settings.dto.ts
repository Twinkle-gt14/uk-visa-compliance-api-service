export type SimpleReferenceKind = "department" | "role" | "visa_type" | "work_location";

export interface SimpleReferenceItemDto {
  id: string;
  name: string;
}

export interface CreateSimpleReferenceDto {
  name: string;
}

export interface UpdateSimpleReferenceDto {
  name: string;
}

export interface HolidayDto {
  id: string;
  date: string; // "YYYY-MM-DD"
  name: string;
}

export interface CreateHolidayDto {
  date: string;
  name: string;
}

export interface UpdateHolidayDto {
  date?: string;
  name?: string;
}

export interface EmployerProfileDto {
  companyName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  county: string;
  postcode: string;
  country: string;
  primaryContactName: string;
  primaryContactEmail: string;
  primaryContactPhone: string;
  /** Domain half of an employee's login email (E000001@<this>) - set
   * explicitly here rather than derived from companyName, since a
   * legal company name (e.g. "ABC Solutions Ltd.") has no unambiguous
   * slug. Required before Onboard can provision an employee login. */
  emailDomain: string;
}

/** Sponsor Licence Number and Sponsor Name (Settings > Sponsorship) -
 * split out from Employer, but still stored on the same
 * reference.employer_profile row: both are genuinely singleton,
 * tenant-level facts, just organised as two screens instead of one. */
export interface SponsorshipProfileDto {
  companyName: string;
  sponsorLicenceNumber: string;
  sponsorName: string;
}

export interface JurisdictionDto {
  id: string;
  code: string;
  name: string;
}

export interface WorkLocationDto {
  id: string;
  name: string;
  jurisdictionId: string | null;
  jurisdictionName: string | null;
}

/** Job title (`name`) plus the full role profile Candidate
 * Onboarding's Role Details step displays once a role is picked
 * from the dropdown there - see migrations 026 and 027. */
export interface RoleDto {
  id: string;
  name: string;
  workLocation: string | null;
  mainDuties: string | null;
  requiredSkills: string | null;
  salaryRange: string | null;
  reportingLine: string | null;
  businessJustification: string | null;
  weeklyWorkingHours: string | null;
  advertised: string | null;
}

export interface Soc2020CodeDto {
  id: string;
  socCode: string;
  socTitle: string;
  majorGroup: string;
  majorGroupTitle: string;
  subMajorGroup: string;
  subMajorGroupTitle: string;
  minorGroup: string;
  minorGroupTitle: string;
  changeNote: string;
  verno: string;
}

export interface PreEmploymentValidationRuleDto {
  id: string;
  category: string;
  ruleId: string;
  checkpoint: string;
  consequence: string;
  source: string;
}

export interface EmployeeComplianceSheetDto {
  sheetName: string;
  rows: (string | number | null)[][];
}
