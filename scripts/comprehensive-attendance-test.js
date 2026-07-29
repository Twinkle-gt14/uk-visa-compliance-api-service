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

async function createTestEmployee() {
  const res = await req("POST", "/employees", {
    firstName: "Attendance", lastName: "Tester", dateOfBirth: "1990-01-01",
    jobTitle: "Tester", department: "Engineering", startDate: "2024-01-01",
  });
  return res.body.id;
}

async function main() {
  const employeeId = await createTestEmployee();
  console.log(`Test employee: ${employeeId}\n`);

  console.log("=== TEST 1: Empty month has no fabricated data ===");
  const empty = await req("GET", `/attendance/${employeeId}?year=2026&month=6`);
  check("Empty month returns {} (no fabricated 'present' days)", Object.keys(empty.body).length === 0, empty.body);

  console.log("\n=== TEST 2: Single day upsert (present, with swipe) ===");
  const day1 = await req("PUT", `/attendance/${employeeId}/2026-07-01`, {
    status: "present", checkIn: "09:59", checkOut: "18:30",
  });
  check("Upsert day 1 succeeds", day1.status === 200, day1.body);

  const afterDay1 = await req("GET", `/attendance/${employeeId}?year=2026&month=6`);
  check("Day 1 now appears in month fetch", afterDay1.body[1]?.status === "present", afterDay1.body[1]);
  check("checkIn round-trips as HH:MM", afterDay1.body[1]?.checkIn === "09:59", afterDay1.body[1]?.checkIn);
  check("checkOut round-trips as HH:MM", afterDay1.body[1]?.checkOut === "18:30", afterDay1.body[1]?.checkOut);

  console.log("\n=== TEST 3: Re-upsert same day updates, doesn't duplicate ===");
  await req("PUT", `/attendance/${employeeId}/2026-07-01`, { status: "remote", checkIn: "10:00", checkOut: "17:00" });
  const afterUpdate = await req("GET", `/attendance/${employeeId}?year=2026&month=6`);
  check("Day 1 updated to remote (not duplicated)", afterUpdate.body[1]?.status === "remote", afterUpdate.body[1]);
  check("Only one entry for day 1", Object.keys(afterUpdate.body).length === 1, afterUpdate.body);

  console.log("\n=== TEST 4: Leave entry with no swipe ===");
  const day2 = await req("PUT", `/attendance/${employeeId}/2026-07-02`, { status: "leave", note: "Annual leave" });
  check("Leave day upserts without checkIn/checkOut", day2.status === 200, day2.body);
  const afterLeave = await req("GET", `/attendance/${employeeId}?year=2026&month=6`);
  check("Leave day has no checkIn", afterLeave.body[2]?.checkIn === null, afterLeave.body[2]);
  check("Leave day note round-trips", afterLeave.body[2]?.note === "Annual leave", afterLeave.body[2]?.note);

  console.log("\n=== TEST 5: Batch upsert (simulating 'copy to current week') ===");
  const batch = await req("POST", `/attendance/${employeeId}/batch`, {
    records: [
      { date: "2026-07-06", status: "present", checkIn: "09:30", checkOut: "18:00" },
      { date: "2026-07-07", status: "present", checkIn: "09:30", checkOut: "18:00" },
      { date: "2026-07-08", status: "present", checkIn: "09:30", checkOut: "18:00" },
    ],
  });
  check("Batch upsert succeeds with count 3", batch.status === 201 && batch.body.count === 3, batch.body);
  const afterBatch = await req("GET", `/attendance/${employeeId}?year=2026&month=6`);
  check("All 3 batch days now present", [6, 7, 8].every((d) => afterBatch.body[d]?.status === "present"), afterBatch.body);

  console.log("\n=== TEST 6: Guard rails ===");
  const badStatus = await req("PUT", `/attendance/${employeeId}/2026-07-10`, { status: "on-holiday-somewhere" });
  check("Invalid status is a clean 400", badStatus.status === 400, badStatus.body);

  const badTimeOrder = await req("PUT", `/attendance/${employeeId}/2026-07-11`, { status: "present", checkIn: "18:00", checkOut: "09:00" });
  check("Check-out before check-in is a clean 400", badTimeOrder.status === 400, badTimeOrder.body);

  const badDate = await req("PUT", `/attendance/${employeeId}/not-a-date`, { status: "present" });
  check("Invalid date is a clean 400", badDate.status === 400, badDate.body);

  const nonExistentEmployee = await req("PUT", `/attendance/${require("crypto").randomUUID()}/2026-07-12`, { status: "present" });
  check("Non-existent employee is a clean 404", nonExistentEmployee.status === 404, nonExistentEmployee.body);

  const emptyBatch = await req("POST", `/attendance/${employeeId}/batch`, { records: [] });
  check("Empty batch is a clean 400", emptyBatch.status === 400, emptyBatch.body);

  console.log("\n=== TEST 7: No auth ===");
  const noAuth = await fetch(`${BASE}/attendance/${employeeId}?year=2026&month=6`);
  check("No auth is rejected (401)", noAuth.status === 401);

  console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
