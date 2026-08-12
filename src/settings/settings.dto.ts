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
  tradingName: string;
  registeredAddress: string;
  companiesHouseNumber: string;
  sponsorLicenceNumber: string;
  sponsorName: string;
  payeReference: string;
  accountsOfficeReference: string;
  primaryContactName: string;
  primaryContactEmail: string;
  primaryContactPhone: string;
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
