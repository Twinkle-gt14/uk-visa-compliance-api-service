export type AttendanceStatus = "present" | "remote" | "leave" | "sick-leave" | "absent";

export interface AttendanceDayDto {
  status: AttendanceStatus;
  checkIn?: string | null; // "HH:MM" 24-hour
  checkOut?: string | null;
  note?: string | null;
}

export interface AttendanceDayRecordDto extends AttendanceDayDto {
  date: string; // "YYYY-MM-DD"
}

/** Used for "copy this day to the current week/month/other days" from
 * the Add Timesheet modal - upserts several days in one transaction
 * instead of one request per day. */
export interface AttendanceBatchUpsertDto {
  records: AttendanceDayRecordDto[];
}
