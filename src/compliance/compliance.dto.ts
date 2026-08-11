export type SkilledWorkerStatus = "Eligible" | "Not Eligible" | "Conditional" | "Transitional" | "Not Mapped";
export type ImportBatchStatus = "Pending Review" | "Approved" | "Cancelled";
export type ImportOutcome = "Matched" | "Not Matched" | "Duplicate" | "Invalid";

/** One row of the main Skilled Worker Occupations list/table -
 * SOC identity joined with whatever active rule currently exists
 * (or none, in which case status is "Not Mapped" client-side). */
export interface SkilledWorkerListItemDto {
  socCode: string;
  socTitle: string;
  majorGroup: string;
  subMajorGroup: string;
  minorGroup: string;
  status: SkilledWorkerStatus;
  sourceTable: string | null;
  goingRate: number | null;
  hasSalaryOptions: boolean;
  effectiveFrom: string | null;
}

export interface SkilledWorkerSummaryCountsDto {
  totalSocOccupations: number;
  mapped: number;
  notMapped: number;
  eligible: number;
  notEligible: number;
  conditionalOrTransitional: number;
}

export interface SkilledWorkerRuleDto {
  id: string;
  socCode: string;
  sourceTable: string;
  status: SkilledWorkerStatus;
  homeOfficeRelatedJobTitles: string;
  goingRate: number | null;
  goingRate90: number | null;
  goingRate80: number | null;
  goingRate70: number | null;
  phdPointsEligible: boolean | null;
  specialConditions: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceVersion: string;
  sourceUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkilledWorkerDetailDto {
  soc: {
    socCode: string;
    socTitle: string;
    majorGroup: string;
    majorGroupTitle: string;
    subMajorGroup: string;
    subMajorGroupTitle: string;
    minorGroup: string;
    minorGroupTitle: string;
  };
  activeRules: SkilledWorkerRuleDto[]; // usually 0 or 1, but a SOC code can be active in more than one source table at once
  historicalRules: SkilledWorkerRuleDto[];
}

export interface UpdateSkilledWorkerRuleDto {
  sourceTable: string;
  status: SkilledWorkerStatus;
  homeOfficeRelatedJobTitles?: string;
  goingRate?: number | null;
  goingRate90?: number | null;
  goingRate80?: number | null;
  goingRate70?: number | null;
  phdPointsEligible?: boolean | null;
  specialConditions?: string;
  effectiveFrom?: string; // defaults to today if omitted
  sourceVersion?: string;
  sourceUrl?: string;
}

export interface ImportBatchRecordDto {
  id: string;
  socCode: string | null;
  sourceTable: string;
  outcome: ImportOutcome;
  occupationTitle: string | null; // resolved from soc_occupation_master when matched, for readability in the preview
}

export interface ImportBatchDto {
  id: string;
  sourceFilename: string;
  status: ImportBatchStatus;
  matchedCount: number;
  unmatchedCount: number;
  duplicateCount: number;
  invalidCount: number;
  uploadedAt: string;
  reviewedAt: string | null;
  records?: ImportBatchRecordDto[]; // included on the detail fetch, omitted from list
}

export interface HealthcarePayBandDto {
  id: string;
  bandLabel: string;
  england: number | null;
  scotland: number | null;
  wales: number | null;
  northernIreland: number | null;
}

export interface EducationPayScaleDto {
  id: string;
  roleLabel: string;
  england: number | null;
  londonFringe: number | null;
  outerLondon: number | null;
  innerLondon: number | null;
  scotland: number | null;
  wales: number | null;
  northernIreland: number | null;
}
