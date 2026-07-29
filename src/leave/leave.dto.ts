export type LeaveRequestStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface LeaveTypeDto {
  id: string;
  slug: string;
  name: string;
  category: "Statutory" | "Employer";
  paidUnpaid: "Paid" | "Unpaid";
  annualEntitlement: number;
  carryForward: boolean;
  maxCarryForward: number;
  selected: boolean;
  order: number;
}

/** Mirrors the frontend's ApplyLeavePage submission shape (lib/leave-
 * requests.ts's `addLeaveRequest` input) field-for-field, so the
 * frontend can be pointed at this endpoint later with no reshaping. */
export interface CreateLeaveRequestDto {
  employeeId: string;
  startDate: string; // "YYYY-MM-DD"
  endDate: string; // "YYYY-MM-DD"
  leaveType: string; // leave type name or slug, resolved server-side
  reason: string;
  contactNumber: string;
  documentFileName?: string | null;
}

export interface LeaveRequestDto {
  id: string;
  employeeId: string;
  startDate: string;
  endDate: string;
  noOfDays: number;
  leaveType: string;
  leaveTypeId: string;
  reason: string;
  contactNumber: string;
  documentFileName: string | null;
  status: LeaveRequestStatus;
  submittedAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
}

export interface DecideLeaveRequestDto {
  decision: "approved" | "rejected";
  decidedByName?: string;
  decisionNote?: string;
}

export interface LeaveSummaryRowDto {
  leaveType: LeaveTypeDto;
  credited: number;
  approved: number;
  awaitingApproval: number;
  balance: number;
}

/** All fields optional - Settings > Leave Types lets you edit any
 * subset (entitlement, selected toggle, carry-forward rule, etc.)
 * without resubmitting the whole row. */
export interface UpdateLeaveTypeDto {
  name?: string;
  category?: "Statutory" | "Employer";
  paidUnpaid?: "Paid" | "Unpaid";
  annualEntitlement?: number;
  carryForward?: boolean;
  maxCarryForward?: number;
  selected?: boolean;
  order?: number;
}
