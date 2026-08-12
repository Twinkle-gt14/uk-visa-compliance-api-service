/**
 * These interfaces deliberately mirror uk-visa-shell's
 * lib/employee-types.ts EmployeeFormData shape field-for-field, so the
 * Add/Edit wizard's existing payload can be sent to this API with
 * minimal translation work on the frontend (Technical Design Document,
 * Section 6). The service maps these into the snake_case, multi-table
 * schema in migrations/001_employee_schema.sql internally - callers
 * never need to know the table layout.
 */

export interface EmailEntryDto {
  id?: string;
  type: string;
  email: string;
  isPrimary: boolean;
}
export interface PhoneEntryDto {
  id?: string;
  type: string;
  number: string;
  isPrimary: boolean;
}
export interface AddressEntryDto {
  id?: string;
  type: string;
  line1: string;
  line2?: string;
  city: string;
  county?: string;
  postcode: string;
  country?: string;
  isPrimary: boolean;
}
export interface EducationEntryDto {
  id?: string;
  institution?: string;
  qualification?: string;
  fieldOfStudy?: string;
  startDate?: string;
  endDate?: string;
  grade?: string;
  certificateFileName?: string | null;
}
export interface CertificationEntryDto {
  id?: string;
  name?: string;
  issuingBody?: string;
  certificateNumber?: string;
  issueDate?: string;
  expiryDate?: string;
  fileName?: string | null;
}
export interface RtwCheckEntryDto {
  id?: string;
  shareCode?: string;
  rtwReference?: string;
  dateOfCheck?: string;
  status?: string;
  expiryDate?: string;
  attachmentFileName?: string | null;
}
export interface DocumentEntryDto {
  id?: string;
  fileName: string;
  documentType?: string;
  description?: string;
  expiryDate?: string;
}

export interface EmployeeUpsertDto {
  // Personal
  photoFileName?: string | null;
  firstName: string;
  middleName?: string;
  lastName: string;
  dateOfBirth: string;
  gender?: string;
  nationality?: string;
  maritalStatus?: string;
  nationalInsuranceNumber?: string;

  // Contact (repeatable)
  emails?: EmailEntryDto[];
  phones?: PhoneEntryDto[];
  addresses?: AddressEntryDto[];

  // Emergency contact (single, per the delivered UI - see Technical Design Section 2)
  emergencyFullName?: string;
  emergencyRelationship?: string;
  emergencyPrimaryPhone?: string;
  emergencySecondaryPhone?: string;
  emergencyAddress?: string;

  // Work
  employeeId?: string;
  candidateId?: string;
  jobTitle: string;
  department: string; // reference.department name or id - see EmployeeService.resolveDepartmentId
  projectWorkBranch?: string;
  reportingManager?: string;
  employmentType?: string;
  startDate: string;
  workLocation?: string;
  workTiming?: string;
  standardHoursPerWeek?: string;
  hourlyRate?: string; // added for Payslip - the Work step doesn't capture this yet on the frontend
  socNumber?: string;
  jobDescription?: string;
  contractDuration?: string;
  currentLocation?: string;
  currentImmigrationStatus?: string;
  proposedAnnualSalary?: string;
  jobContractFileName?: string | null;
  sponsoredEmployee?: string;
  britishEmployee?: string;

  // Bank
  accountHolderName?: string;
  bankName?: string;
  accountNumber?: string;
  sortCode?: string;
  iban?: string;
  bankDocumentFileName?: string | null;

  // Education & certifications (repeatable)
  education?: EducationEntryDto[];
  certifications?: CertificationEntryDto[];

  // Passport
  passportNumber?: string;
  passportIssuingCountry?: string;
  passportIssueDate?: string;
  passportExpiryDate?: string;
  passportFileName?: string | null;

  // Visa
  visaType?: string;
  visaNumber?: string;
  visaIssueDate?: string;
  visaExpiryDate?: string;
  visaConditions?: string[];
  visaFileName?: string | null;

  // Certificate of Sponsorship
  cosLicenceNumber?: string;
  cosSponsorName?: string;
  cosCertificateNumber?: string;
  cosCertificateDate?: string;
  cosAssignedDate?: string;
  cosExpiryDate?: string;
  cosSponsorNote?: string;
  cosFileName?: string | null;

  // Right to work (repeatable)
  rtwChecks?: RtwCheckEntryDto[];

  // General documents (repeatable)
  documents?: DocumentEntryDto[];
}

export type EmployeeStatus = "Active" | "Inactive" | "Exited";

export interface UpdateStatusDto {
  recordStatus: EmployeeStatus;
}

export interface EmployeeSummary {
  id: string;
  employeeReferenceNo: string;
  fullName: string;
  jobTitle: string;
  department: string;
  recordStatus: EmployeeStatus;
}
