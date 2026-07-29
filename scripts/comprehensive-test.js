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

async function req(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

// The FULL realistic payload - every field the wizard's EMPTY_EMPLOYEE_FORM
// defines, filled in exactly as a thorough real user would across every step.
const FULL_PAYLOAD = {
  photoFileName: "priya-photo.jpg",
  firstName: "Priya",
  middleName: "R",
  lastName: "Nair",
  dateOfBirth: "1990-05-01",
  gender: "Female",
  nationality: "Indian",
  maritalStatus: "Single",
  nationalInsuranceNumber: "QQ111111C",

  emails: [
    { type: "Work", email: "priya.work@example.com", isPrimary: true },
    { type: "Personal", email: "priya.personal@example.com", isPrimary: false },
  ],
  phones: [{ type: "Mobile", number: "07700900001", isPrimary: true }],
  addresses: [
    { type: "Current", line1: "1 Main St", line2: "Flat 2", city: "London", county: "Greater London", postcode: "E1 6AN", country: "UK", isPrimary: true },
  ],

  emergencyFullName: "Raj Nair",
  emergencyRelationship: "Spouse",
  emergencyPrimaryPhone: "07700900002",
  emergencySecondaryPhone: "07700900003",
  emergencyAddress: "1 Main St, London",

  employeeId: "EMP-001",
  jobTitle: "Software Engineer",
  department: "Engineering",
  projectWorkBranch: "Platform Team",
  reportingManager: "Alex Manager",
  employmentType: "Full-time",
  startDate: "2024-01-15",
  workLocation: "London Office",
  workTiming: "9-5",
  standardHoursPerWeek: "37.5",
  socNumber: "2136",
  jobContractFileName: "contract.pdf",
  sponsoredEmployee: "No",
  britishEmployee: "Yes",

  accountHolderName: "Priya Nair",
  bankName: "Barclays",
  accountNumber: "12345678",
  sortCode: "20-00-00",
  iban: "GB29NWBK60161331926819",
  bankDocumentFileName: "bank-doc.pdf",

  education: [
    { institution: "University of Manchester", qualification: "BSc Computer Science", fieldOfStudy: "CS", startDate: "2009-09-01", endDate: "2012-06-30", grade: "2:1", certificateFileName: "degree.pdf" },
  ],
  certifications: [
    { name: "AWS Certified", issuingBody: "Amazon", certificateNumber: "AWS-123", issueDate: "2022-01-01", expiryDate: "2025-01-01", fileName: "aws-cert.pdf" },
  ],

  passportNumber: "123456789",
  passportIssuingCountry: "India",
  passportIssueDate: "2018-01-01",
  passportExpiryDate: "2028-01-01",
  passportFileName: "passport.pdf",

  visaType: "Skilled Worker",
  visaNumber: "V-987654",
  visaIssueDate: "2023-01-01",
  visaExpiryDate: "2026-01-01",
  visaConditions: "No recourse to public funds",
  visaFileName: "visa.pdf",

  cosLicenceNumber: "ABC123",
  cosSponsorName: "UK Visa Compliance Ltd",
  cosCertificateNumber: "COS-001",
  cosCertificateDate: "2022-12-01",
  cosAssignedDate: "2022-12-15",
  cosExpiryDate: "2026-01-01",
  cosSponsorNote: "Standard sponsorship",
  cosFileName: "cos.pdf",

  rtwChecks: [
    { shareCode: "ABC-123-XYZ", rtwReference: "RTW-001", dateOfCheck: "2022-12-01", status: "Approved", expiryDate: "2026-01-01", attachmentFileName: "rtw-check.pdf" },
  ],

  documents: [
    { fileName: "misc-doc.pdf", documentType: "Other", description: "Misc supporting doc", expiryDate: "" },
  ],
};

// Realistic "quick" payload: only the mandatory fields filled, every
// optional section left exactly as the wizard's own defaults (empty
// strings / empty arrays) - this is the most common real-world case.
const MINIMAL_PAYLOAD = {
  photoFileName: null,
  firstName: "Minimal",
  middleName: "",
  lastName: "User",
  dateOfBirth: "1992-03-03",
  gender: "",
  nationality: "",
  maritalStatus: "",
  nationalInsuranceNumber: "",
  emails: [{ id: "e1", type: "Work", email: "minimal@example.com", isPrimary: true }],
  phones: [{ id: "p1", type: "Mobile", number: "07000000000", isPrimary: true }],
  addresses: [{ id: "a1", type: "Current", line1: "2 Side St", line2: "", city: "Leeds", county: "", postcode: "LS1 1AA", country: "", isPrimary: true }],
  emergencyFullName: "Emergency Contact",
  emergencyRelationship: "Friend",
  emergencyPrimaryPhone: "07111111111",
  emergencySecondaryPhone: "",
  emergencyAddress: "",
  employeeId: "",
  jobTitle: "Analyst",
  department: "Engineering",
  projectWorkBranch: "",
  reportingManager: "",
  employmentType: "",
  startDate: "2024-06-01",
  workLocation: "",
  workTiming: "",
  standardHoursPerWeek: "",
  socNumber: "",
  jobContractFileName: null,
  sponsoredEmployee: "No",
  britishEmployee: "No",
  accountHolderName: "",
  bankName: "",
  accountNumber: "",
  sortCode: "",
  iban: "",
  bankDocumentFileName: null,
  education: [],
  certifications: [],
  passportNumber: "",
  passportIssuingCountry: "",
  passportIssueDate: "",
  passportExpiryDate: "",
  passportFileName: null,
  visaType: "",
  visaNumber: "",
  visaIssueDate: "",
  visaExpiryDate: "",
  visaConditions: "",
  visaFileName: null,
  cosLicenceNumber: "",
  cosSponsorName: "",
  cosCertificateNumber: "",
  cosCertificateDate: "",
  cosAssignedDate: "",
  cosExpiryDate: "",
  cosSponsorNote: "",
  cosFileName: null,
  rtwChecks: [],
  documents: [],
};

async function main() {
  console.log("=== TEST 1: Full payload, every field filled ===");
  const create1 = await req("POST", "/employees", FULL_PAYLOAD);
  check("Full payload creates successfully (201)", create1.status === 201, create1.body);
  const id1 = create1.body.id;

  if (id1) {
    const get1 = await req("GET", `/employees/${id1}`);
    check("GET returns 200", get1.status === 200);
    const g = get1.body;
    check("reportingManager round-trips", g.reportingManager === "Alex Manager", g.reportingManager);
    check("photoFileName round-trips", g.photoFileName === "priya-photo.jpg", g.photoFileName);
    check("nationalInsuranceNumber decrypts correctly", g.nationalInsuranceNumber === "QQ111111C", g.nationalInsuranceNumber);
    check("accountNumber decrypts correctly", g.accountNumber === "12345678", g.accountNumber);
    check("2 emails round-trip", g.emails?.length === 2, g.emails);
    check("1 education entry round-trips", g.education?.length === 1, g.education);
    check("1 certification round-trips", g.certifications?.length === 1, g.certifications);
    check("1 rtwCheck round-trips", g.rtwChecks?.length === 1, g.rtwChecks);
    check("1 document round-trips", g.documents?.length === 1, g.documents);
    check("cosLicenceNumber round-trips", g.cosLicenceNumber === "ABC123", g.cosLicenceNumber);
    check("visaExpiryDate round-trips", g.visaExpiryDate === "2026-01-01", g.visaExpiryDate);

    console.log("\n=== TEST 2: Partial update (edit only job title) ===");
    const patch1 = await req("PATCH", `/employees/${id1}`, { jobTitle: "Senior Software Engineer" });
    check("Partial update succeeds", patch1.status === 200, patch1.body);
    const get2 = await req("GET", `/employees/${id1}`);
    check("Job title updated", get2.body.jobTitle === "Senior Software Engineer", get2.body.jobTitle);
    check("Other fields unaffected by partial update", get2.body.lastName === "Nair", get2.body.lastName);

    console.log("\n=== TEST 3: Guard rails - can't blank required fields via update ===");
    const badPatch1 = await req("PATCH", `/employees/${id1}`, { dateOfBirth: "" });
    check("Blanking dateOfBirth is rejected (400)", badPatch1.status === 400, badPatch1.body);
    const badPatch2 = await req("PATCH", `/employees/${id1}`, { startDate: "" });
    check("Blanking startDate is rejected (400)", badPatch2.status === 400, badPatch2.body);
    const badPatch3 = await req("PATCH", `/employees/${id1}`, { department: "" });
    check("Blanking department is rejected (400)", badPatch3.status === 400, badPatch3.body);

    console.log("\n=== TEST 4: Status toggle ===");
    const status1 = await req("PATCH", `/employees/${id1}/status`, { recordStatus: "Inactive" });
    check("Status update succeeds", status1.status === 200 && status1.body.recordStatus === "Inactive", status1.body);
  }

  console.log("\n=== TEST 5: Minimal realistic payload (only mandatory fields) ===");
  const create2 = await req("POST", "/employees", MINIMAL_PAYLOAD);
  check("Minimal payload creates successfully (201)", create2.status === 201, create2.body);
  if (create2.body.id) {
    const get3 = await req("GET", `/employees/${create2.body.id}`);
    check("GET on minimal record succeeds", get3.status === 200, get3.body);
    check("Empty optional fields come back as empty string, not crash", get3.body.passportNumber === "", get3.body.passportNumber);
  }

  console.log("\n=== TEST 6: Missing mandatory field on create (clean 400, not 500) ===");
  const badCreate = await req("POST", "/employees", { ...MINIMAL_PAYLOAD, startDate: "" });
  check("Missing startDate is a clean 400", badCreate.status === 400, badCreate.body);
  const badCreate2 = await req("POST", "/employees", { ...MINIMAL_PAYLOAD, firstName: "" });
  check("Missing firstName is a clean 400", badCreate2.status === 400, badCreate2.body);

  console.log("\n=== TEST 7: Pagination ===");
  const list1 = await req("GET", "/employees?page=1&pageSize=1");
  check("Pagination returns exactly pageSize items", list1.body.items?.length === 1, list1.body);
  check("Pagination reports a total >= 2", list1.body.total >= 2, list1.body.total);

  console.log("\n=== TEST 8: Idempotency ===");
  const idemBody = { ...MINIMAL_PAYLOAD, firstName: "Idem", lastName: "Test2" };
  const idem1 = await req("POST", "/employees", idemBody, { "Idempotency-Key": "test-key-999" });
  const idem2 = await req("POST", "/employees", idemBody, { "Idempotency-Key": "test-key-999" });
  check("Idempotent retry returns the same id", idem1.body.id && idem1.body.id === idem2.body.id, { first: idem1.body, second: idem2.body });

  console.log("\n=== TEST 9: Duplicate NI number ===");
  const dup1 = await req("POST", "/employees", { ...MINIMAL_PAYLOAD, firstName: "Dup1", nationalInsuranceNumber: "AB999999D" });
  const dup2 = await req("POST", "/employees", { ...MINIMAL_PAYLOAD, firstName: "Dup2", nationalInsuranceNumber: "AB999999D" });
  check("Duplicate NI number is rejected (409)", dup2.status === 409, dup2.body);

  console.log("\n=== TEST 10: No auth ===");
  const noAuth = await fetch(BASE + "/employees");
  check("No auth is rejected (401)", noAuth.status === 401);

  console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
