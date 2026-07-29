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

async function testSimpleResource(label, basePath) {
  console.log(`\n=== ${label} ===`);
  const created = await req("POST", basePath, { name: `Test ${label} A` });
  check(`${label}: create succeeds`, created.status === 201, created.body);

  const dup = await req("POST", basePath, { name: `Test ${label} A` });
  check(`${label}: duplicate name is a clean 409`, dup.status === 409, dup.body);

  const list = await req("GET", basePath);
  check(`${label}: list includes the created item`, list.body.some((i) => i.id === created.body.id), list.body);

  const updated = await req("PATCH", `${basePath}/${created.body.id}`, { name: `Test ${label} B` });
  check(`${label}: update succeeds`, updated.body.name === `Test ${label} B`, updated.body);

  const deleted = await req("DELETE", `${basePath}/${created.body.id}`);
  check(`${label}: delete succeeds`, deleted.status === 200, deleted.body);

  const missingUpdate = await req("PATCH", `${basePath}/${created.body.id}`, { name: "Ghost" });
  check(`${label}: updating a deleted item is a clean 404`, missingUpdate.status === 404, missingUpdate.body);
}

async function main() {
  await testSimpleResource("Position", "/settings/positions");
  await testSimpleResource("VisaType", "/settings/visa-types");
  await testSimpleResource("WorkLocation", "/settings/work-locations");

  console.log("\n=== Department: create, then confirm delete is BLOCKED once an employee uses it ===");
  const dept = await req("POST", "/settings/departments", { name: "Test Department For Deletion" });
  check("Department creates", dept.status === 201, dept.body);

  const emp = await req("POST", "/employees", {
    firstName: "Dept", lastName: "User", dateOfBirth: "1990-01-01",
    jobTitle: "Tester", department: "Test Department For Deletion", startDate: "2024-01-01",
  });
  check("Employee created in that department", emp.status === 201, emp.body);

  const blockedDelete = await req("DELETE", `/settings/departments/${dept.body.id}`);
  check("Deleting a department with employees is a clean 409, not a raw 500", blockedDelete.status === 409, blockedDelete.body);

  console.log("\n=== Holidays ===");
  const holiday = await req("POST", "/settings/holidays", { date: "2026-12-25", name: "Christmas Day" });
  check("Holiday creates", holiday.status === 201, holiday.body);
  const dupHoliday = await req("POST", "/settings/holidays", { date: "2026-12-25", name: "Duplicate" });
  check("Duplicate holiday date is a clean 409", dupHoliday.status === 409, dupHoliday.body);
  const holidayList = await req("GET", "/settings/holidays");
  check("Holiday list includes it, date is plain YYYY-MM-DD", holidayList.body.some((h) => h.date === "2026-12-25"), holidayList.body);
  const holidayDelete = await req("DELETE", `/settings/holidays/${holiday.body.id}`);
  check("Holiday delete succeeds", holidayDelete.status === 200, holidayDelete.body);

  console.log("\n=== Employer profile (singleton) ===");
  const emptyProfile = await req("GET", "/settings/employer");
  check("Empty profile returns shaped-but-blank object, not 404", emptyProfile.status === 200 && emptyProfile.body.companyName === "", emptyProfile.body);

  const savedProfile = await req("PATCH", "/settings/employer", {
    companyName: "UK Visa Compliance Ltd",
    sponsorLicenceNumber: "ABC123456",
    primaryContactEmail: "hr@ukvisacompliance.com",
  });
  check("Profile saves", savedProfile.body.companyName === "UK Visa Compliance Ltd", savedProfile.body);

  const rereadProfile = await req("GET", "/settings/employer");
  check("Profile persists on re-read", rereadProfile.body.sponsorLicenceNumber === "ABC123456", rereadProfile.body);

  const updatedProfile = await req("PATCH", "/settings/employer", { tradingName: "UKVC" });
  check("Partial update doesn't wipe previously-saved fields", updatedProfile.body.companyName === "UK Visa Compliance Ltd" && updatedProfile.body.tradingName === "UKVC", updatedProfile.body);

  console.log("\n=== No auth ===");
  const noAuth = await fetch(`${BASE}/settings/departments`);
  check("No auth is rejected (401)", noAuth.status === 401);

  console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
