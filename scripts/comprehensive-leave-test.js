const jwt = require("jsonwebtoken");

const BASE = "http://localhost:8080";
const TENANT = "0e7af6de-447a-444b-a75f-070f198af0e8";
const TOKEN = jwt.sign({ userId: require("crypto").randomUUID(), tenantId: TENANT }, "test-secret", { expiresIn: "15m" });

let failures = 0;
function check(label, condition, extra) {
  if (condition) {
    console.log(`\u2713 PASS: ${label}`);
  } else {
    failures++;
    console.log(`\u2717 FAIL: ${label}${extra ? " -- " + JSON.stringify(extra) : ""}`);
  }
}

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function createTestEmployee(dateOfJoining) {
  const res = await req("POST", "/employees", {
    firstName: "Leave", lastName: "Tester", dateOfBirth: "1990-01-01",
    jobTitle: "Tester", department: "Engineering", startDate: dateOfJoining || "2020-01-01",
  });
  return res.body.id;
}

async function main() {
  console.log("=== TEST 1: Leave types seed on first request ===");
  const types = await req("GET", "/leave/types");
  check("Returns 8 default leave types", Array.isArray(types.body) && types.body.length === 8, types.body);
  const annual = types.body.find((t) => t.slug === "annual-leave");
  check("Annual Leave defaults match frontend (28 days, carry forward)", annual?.annualEntitlement === 28 && annual?.carryForward === true, annual);

  const typesAgain = await req("GET", "/leave/types");
  check("Second call doesn't re-seed (still 8, same ids)", typesAgain.body.length === 8 && typesAgain.body[0].id === types.body[0].id, typesAgain.body);

  const employeeId = await createTestEmployee("2020-01-01");
  console.log(`\nTest employee (joined 2020, no proration expected): ${employeeId}\n`);

  console.log("=== TEST 2: Create a leave request ===");
  // 2026-07-06 is a Monday, 2026-07-10 is a Friday - 5 calendar days, all weekdays.
  const created = await req("POST", "/leave/requests", {
    employeeId, startDate: "2026-07-06", endDate: "2026-07-10",
    leaveType: "Annual Leave (Holiday)", reason: "Family trip", contactNumber: "07700900000",
  });
  check("Create succeeds", created.status === 201 || created.status === 200, created.body);
  check("Status starts pending", created.body.status === "pending", created.body);
  check("noOfDays computed as inclusive calendar days (5)", created.body.noOfDays === 5, created.body);
  const requestId = created.body.id;

  console.log("\n=== TEST 3: Overlapping request is rejected ===");
  const overlap = await req("POST", "/leave/requests", {
    employeeId, startDate: "2026-07-08", endDate: "2026-07-12",
    leaveType: "Sick Leave", reason: "Overlap test", contactNumber: "07700900000",
  });
  check("Overlapping pending request is a clean 409", overlap.status === 409, overlap.body);

  console.log("\n=== TEST 4: List requests ===");
  const list = await req("GET", `/leave/requests?employeeId=${employeeId}`);
  check("Lists the created request", list.body.some((r) => r.id === requestId), list.body);

  console.log("\n=== TEST 5: Summary reflects the pending request ===");
  const summaryBefore = await req("GET", `/leave/summary/${employeeId}?referenceDate=2026-07-15`);
  const annualRow = summaryBefore.body.find((r) => r.leaveType.slug === "annual-leave");
  check("Awaiting approval shows the 5 pending days", annualRow?.awaitingApproval === 5, annualRow);
  check("Balance = 28 - 5 awaiting = 23", annualRow?.balance === 23, annualRow);

  console.log("\n=== TEST 6: Approve, and confirm it writes attendance rows on weekdays only ===");
  const approve = await req("POST", `/leave/requests/${requestId}/decision`, { decision: "approved", decidedByName: "Test Manager" });
  check("Approve succeeds", approve.status === 200 || approve.status === 201, approve.body);
  check("Status is now approved", approve.body.status === "approved", approve.body);

  const attendanceJuly = await req("GET", `/attendance/${employeeId}?year=2026&month=6`);
  check("Mon 6th written as 'leave'", attendanceJuly.body[6]?.status === "leave", attendanceJuly.body[6]);
  check("Fri 10th written as 'leave'", attendanceJuly.body[10]?.status === "leave", attendanceJuly.body[10]);
  check("Sat/Sun (11th/12th) NOT fabricated", !attendanceJuly.body[11] && !attendanceJuly.body[12], attendanceJuly.body);

  console.log("\n=== TEST 7: Summary reflects approved, not pending, after decision ===");
  const summaryAfter = await req("GET", `/leave/summary/${employeeId}?referenceDate=2026-07-15`);
  const annualRowAfter = summaryAfter.body.find((r) => r.leaveType.slug === "annual-leave");
  check("Approved now shows 5, awaiting shows 0", annualRowAfter?.approved === 5 && annualRowAfter?.awaitingApproval === 0, annualRowAfter);

  console.log("\n=== TEST 8: Cannot decide the same request twice ===");
  const redecide = await req("POST", `/leave/requests/${requestId}/decision`, { decision: "rejected" });
  check("Deciding an already-decided request is a clean 400", redecide.status === 400, redecide.body);

  console.log("\n=== TEST 9: Reject a fresh request (no attendance rows written) ===");
  const toReject = await req("POST", "/leave/requests", {
    employeeId, startDate: "2026-08-03", endDate: "2026-08-04",
    leaveType: "Sick Leave", reason: "Flu", contactNumber: "07700900000",
  });
  const reject = await req("POST", `/leave/requests/${toReject.body.id}/decision`, { decision: "rejected", decisionNote: "Insufficient notice" });
  check("Reject succeeds", reject.body.status === "rejected", reject.body);
  const attendanceAugust = await req("GET", `/attendance/${employeeId}?year=2026&month=7`);
  check("Rejected leave writes no attendance rows", Object.keys(attendanceAugust.body).length === 0, attendanceAugust.body);

  console.log("\n=== TEST 10: Cancel a pending request ===");
  const toCancel = await req("POST", "/leave/requests", {
    employeeId, startDate: "2026-09-01", endDate: "2026-09-01",
    leaveType: "Study Leave", reason: "Exam", contactNumber: "07700900000",
  });
  const cancel = await req("POST", `/leave/requests/${toCancel.body.id}/cancel`);
  check("Cancel succeeds", cancel.body.status === "cancelled", cancel.body);
  const cancelTwice = await req("POST", `/leave/requests/${toCancel.body.id}/cancel`);
  check("Cancelling an already-cancelled request is a clean 400", cancelTwice.status === 400, cancelTwice.body);

  console.log("\n=== TEST 11: Guard rails ===");
  const badDates = await req("POST", "/leave/requests", {
    employeeId, startDate: "2026-10-05", endDate: "2026-10-01",
    leaveType: "Annual Leave (Holiday)", reason: "x", contactNumber: "1",
  });
  check("End before start is a clean 400", badDates.status === 400, badDates.body);

  const badType = await req("POST", "/leave/requests", {
    employeeId, startDate: "2026-10-01", endDate: "2026-10-02",
    leaveType: "Not A Real Leave Type", reason: "x", contactNumber: "1",
  });
  check("Unknown leave type is a clean 400", badType.status === 400, badType.body);

  const badDecision = await req("POST", "/leave/requests", {
    employeeId, startDate: "2026-11-02", endDate: "2026-11-02",
    leaveType: "Study Leave", reason: "x", contactNumber: "1",
  });
  const badDecisionResult = await req("POST", `/leave/requests/${badDecision.body.id}/decision`, { decision: "maybe" });
  check("Invalid decision value is a clean 400", badDecisionResult.status === 400, badDecisionResult.body);

  const nonExistentEmployee = await req("POST", "/leave/requests", {
    employeeId: require("crypto").randomUUID(), startDate: "2026-11-02", endDate: "2026-11-02",
    leaveType: "Study Leave", reason: "x", contactNumber: "1",
  });
  check("Non-existent employee is a clean 404", nonExistentEmployee.status === 404, nonExistentEmployee.body);

  console.log("\n=== TEST 12: Proration for an employee who joined mid leave-year ===");
  // Leave year for referenceDate 2026-07-15 is 2026-04-01 to 2027-03-31 (366 days).
  // Joining 2026-10-01 leaves 182 days remaining -> ~13.5 of 28 days prorated.
  const midYearEmployee = await createTestEmployee("2026-10-01");
  const midYearSummary = await req("GET", `/leave/summary/${midYearEmployee}?referenceDate=2026-07-15`);
  const midYearAnnual = midYearSummary.body.find((r) => r.leaveType.slug === "annual-leave");
  check("Mid-year joiner's Annual Leave is prorated below 28", midYearAnnual?.balance < 28 && midYearAnnual?.balance > 0, midYearAnnual);
  const midYearMaternity = midYearSummary.body.find((r) => r.leaveType.slug === "maternity-leave");
  check("Non-prorated types (Maternity) are unaffected by joining date", midYearMaternity?.balance === 90, midYearMaternity);

  console.log("\n=== TEST 13: No auth ===");
  const noAuth = await fetch(`${BASE}/leave/types`);
  check("No auth is rejected (401)", noAuth.status === 401);

  console.log(`\n${failures === 0 ? "All tests passed." : `${failures} test(s) FAILED.`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
