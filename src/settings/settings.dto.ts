export type SimpleReferenceKind = "department" | "position" | "visa_type" | "work_location";

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
