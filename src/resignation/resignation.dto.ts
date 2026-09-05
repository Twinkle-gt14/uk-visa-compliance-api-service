export type ResignationRequestStatus = "pending" | "approved" | "rejected";

export interface CreateResignationRequestDto {
  employeeId: string;
  reason?: string;
}

export interface ResignationRequestDto {
  id: string;
  employeeId: string;
  reason: string | null;
  /** Snapshotted from Settings > HR > Notice Period at the moment this
   * was submitted - see the migration's own doc-comment on why this
   * isn't recomputed from the live setting later. */
  noticeDays: number;
  tentativeLastDate: string; // "YYYY-MM-DD"
  status: ResignationRequestStatus;
  submittedAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
}

export interface DecideResignationRequestDto {
  decision: "approved" | "rejected";
  decidedByName?: string;
  decisionNote?: string;
}

export interface CurrentNoticePeriodDto {
  id: string;
  name: string;
  noticeDays: number;
}
