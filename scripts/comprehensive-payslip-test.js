const jwt = require("jsonwebtoken");

const BASE = "http://localhost:8080";
const TENANT = "0e7af6de-447a-444b-a75f-070f198af0e8";
const TOKEN = jwt.sign({ userId: require("crypto").randomUUID(), tenantId: TENANT }, "test-secret", { expiresIn: "15m" });

let failures = 0;
function check(label, condition, extra) {
  if (condition) console.log(`\u2713 PASS: ${label}`);
  else { failures++; console.log(`\u2717 FAIL: ${label}${extra ? " -- " + JSON.stringify(extra) : ""}`); }
}

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function main() {
  console.log("=== TEST 1: Components seed on first read ===");
  const comps = await req("GET", "/payslip/components");
  check("Returns 20 default components (11 earnings + 9 deductions)", comps.body.length === 20, comps.body.length);
  const overtimeComp = comps.body.find((c) => c.slug === "earn-overtime");
  check("Overtime defaults to selected", overtimeComp?.selected === true, overtimeComp);
  const bonusComp = comps.body.find((c) => c.slug === "earn-bonus");
  check("Bonus defaults to NOT selected", bonusComp?.selected === false, bonusComp);

  console.log("\n=== TEST 2: Employee with no hourly rate -> clean 400, not a crash ===");
  const noRateEmp = await req("POST", "/employees", {
    firstName: "NoRate", lastName: "Test", dateOfBirth: "1990-01-01",
    jobTitle: "Tester", department: "Engineering", startDate: "2024-01-01",
  });
  const noRateResult = await req("GET", `/payslip/${noRateEmp.body.id}?year=2026&month=6`);
  check("No hourly rate is a clean 400", noRateResult.status === 400, noRateResult.body);

  console.log("\n=== TEST 3: Real payslip computation from real attendance hours ===");
  const emp = await req("POST", "/employees", {
    firstName: "Payslip", lastName: "Tester", dateOfBirth: "1990-01-01",
    jobTitle: "Developer", department: "Engineering", startDate: "2020-01-01", hourlyRate: "20",
  });
  const empId = emp.body.id;
  check("Employee created with hourly rate", emp.status === 201, emp.body);

  // 5 days x 8 hours = 40 hours worked this period
  for (const date of ["2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10"]) {
    await req("PUT", `/attendance/${empId}/${date}`, { status: "present", checkIn: "09:00", checkOut: "17:00" });
  }

  const payslip = await req("GET", `/payslip/${empId}?year=2026&month=6`);
  check("Payslip computes successfully", payslip.status === 200, payslip.body);
  check("Hours worked = 40 (real attendance sum, not mock)", payslip.body.hoursWorkedThisPeriod === 40, payslip.body.hoursWorkedThisPeriod);
  check("Basic Pay = 40 x 20 = 800", payslip.body.earningLines.find((l) => l.label === "Basic Pay")?.amount === 800, payslip.body.earningLines);
  check("Overtime line present (enabled by default)", payslip.body.earningLines.some((l) => l.label === "Overtime"), payslip.body.earningLines);
  check("Bonus line NOT present (disabled by default)", !payslip.body.earningLines.some((l) => l.label === "Bonus"), payslip.body.earningLines);
  check("Income Tax and NI always present", payslip.body.deductionLines.some((l) => l.label === "Income Tax") && payslip.body.deductionLines.some((l) => l.label === "National Insurance"), payslip.body.deductionLines);
  check("Net pay = payments - deductions", Math.abs(payslip.body.netPay - (payslip.body.totalPayments - payslip.body.totalDeductions)) < 0.01, payslip.body);

  console.log("\n=== TEST 4: Toggling a component changes the computation ===");
  await req("PATCH", `/payslip/components/${bonusComp.id}`, { selected: true });
  const payslipWithBonus = await req("GET", `/payslip/${empId}?year=2026&month=6`);
  check("Bonus now appears after enabling", payslipWithBonus.body.earningLines.some((l) => l.label === "Bonus"), payslipWithBonus.body.earningLines);
  check("Total payments increased by exactly 150", Math.abs(payslipWithBonus.body.totalPayments - payslip.body.totalPayments - 150) < 0.01, { before: payslip.body.totalPayments, after: payslipWithBonus.body.totalPayments });
  await req("PATCH", `/payslip/components/${bonusComp.id}`, { selected: false }); // reset

  console.log("\n=== TEST 5: Empty period (no attendance) -> 0 hours, not a crash ===");
  const emptyPeriod = await req("GET", `/payslip/${empId}?year=2025&month=0`);
  check("Empty period returns 0 hours cleanly", emptyPeriod.body.hoursWorkedThisPeriod === 0, emptyPeriod.body.hoursWorkedThisPeriod);

  console.log("\n=== TEST 6: Leave type update (Settings > Leave Types real persistence) ===");
  const types = await req("GET", "/leave/types");
  const annual = types.body.find((t) => t.slug === "annual-leave");
  const updated = await req("PATCH", `/leave/types/${annual.id}`, { annualEntitlement: 25 });
  check("Leave type entitlement updates", updated.body.annualEntitlement === 25, updated.body);
  const reread = await req("GET", "/leave/types");
  const rereadAnnual = reread.body.find((t) => t.slug === "annual-leave");
  check("Change persists on re-read", rereadAnnual.annualEntitlement === 25, rereadAnnual);

  console.log("\n=== TEST 7: No auth ===");
  const noAuth = await fetch(`${BASE}/payslip/components`);
  check("No auth is rejected (401)", noAuth.status === 401);

  console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
