export type AccessLevel = "admin" | "hr" | "employee";

/** Menu/page-level permissions a role can be given. The ids match the `permission` field on the
 * front-end's menu items (lib/menu-config.ts) and the page gating in its middleware. `levels` says which
 * kinds of role may hold the permission: staff-only, self-service-only, or both. */
export interface PermissionDef {
  id: string;
  label: string;
  description: string;
  group: string;
  levels: AccessLevel[];
}

const STAFF: AccessLevel[] = ["admin", "hr"];
const SELF: AccessLevel[] = ["employee"];
const BOTH: AccessLevel[] = ["admin", "hr", "employee"];

export const PERMISSIONS: PermissionDef[] = [
  { id: "dashboard.view", label: "Dashboard", description: "See the dashboard and its widgets.", group: "General", levels: BOTH },
  { id: "help.view", label: "Help", description: "Open the help pages.", group: "General", levels: BOTH },

  { id: "candidates.view", label: "Candidate Details", description: "Candidate Register and Convert to Employee.", group: "Candidates & Employees", levels: STAFF },
  { id: "employees.view", label: "Employee Details", description: "Employee Register and Employee Contract End.", group: "Candidates & Employees", levels: BOTH },
  { id: "attendance.calendar.view", label: "Attendance", description: "Attendance calendars.", group: "Candidates & Employees", levels: BOTH },
  { id: "leave.summary.view", label: "Leave Summary", description: "Leave balances and summaries.", group: "Candidates & Employees", levels: BOTH },
  { id: "payslip.view", label: "Payslip", description: "View and generate payslips.", group: "Candidates & Employees", levels: STAFF },

  { id: "compliance.view", label: "Compliance", description: "UKVI Reporting and Expiry Checks.", group: "Compliance & Approvals", levels: STAFF },
  { id: "workflow.view", label: "Approval Workflow", description: "Approve profile changes, leave requests and resignations.", group: "Compliance & Approvals", levels: STAFF },

  { id: "profile.self", label: "My Profile", description: "Open their own employee profile.", group: "Self-service", levels: SELF },
  { id: "leave.view", label: "Leave (self-service)", description: "Apply for leave.", group: "Self-service", levels: SELF },
  { id: "leave.apply", label: "Apply Leave", description: "Submit leave requests.", group: "Self-service", levels: SELF },
  { id: "resignation.view", label: "Resignation (self-service)", description: "Submit a resignation.", group: "Self-service", levels: SELF },

  { id: "settings.view", label: "Settings", description: "Company and compliance settings.", group: "Administration", levels: STAFF },
  { id: "subscription.view", label: "Subscription", description: "Subscription and billing.", group: "Administration", levels: STAFF },
  { id: "users.view", label: "Users & Roles", description: "Manage users, roles and their permissions.", group: "Administration", levels: ["admin"] },
];

export const PERMISSION_IDS = new Set(PERMISSIONS.map((p) => p.id));

const forLevel = (level: AccessLevel) => PERMISSIONS.filter((p) => p.levels.includes(level)).map((p) => p.id);

/** What each built-in role gets, and what a role with no stored permissions falls back to. */
export const DEFAULT_ROLE_PERMISSIONS: Record<AccessLevel, string[]> = {
  admin: forLevel("admin"),
  hr: forLevel("hr"),
  employee: forLevel("employee"),
};

export const SYSTEM_ROLES: { name: string; description: string; accessLevel: AccessLevel }[] = [
  { name: "Admin", description: "Full access, including managing users and roles.", accessLevel: "admin" },
  { name: "HR", description: "Manages candidates, employees, compliance and approvals.", accessLevel: "hr" },
  { name: "Employee", description: "Self-service access to their own records.", accessLevel: "employee" },
];

/** The role claim carried in the login token. Older code only knows 'hr_admin' and 'employee'. */
export type TokenRole = "admin" | "hr_admin" | "employee";

export function tokenRoleFor(level: AccessLevel): TokenRole {
  return level === "admin" ? "admin" : level === "hr" ? "hr_admin" : "employee";
}

const LEVEL_RANK: Record<AccessLevel, number> = { employee: 0, hr: 1, admin: 2 };

/** A user can hold several roles: their access level is the highest of them, and their permissions are the
 * combination of all of them (so HR + Employee gets every HR feature and every self-service feature). */
export function combineRoles(roles: { access_level: AccessLevel; permissions: string[] | null; name: string }[]): {
  level: AccessLevel;
  permissions: string[];
  names: string[];
} {
  let level: AccessLevel = "employee";
  const permissions = new Set<string>();
  for (const r of roles) {
    if (LEVEL_RANK[r.access_level] > LEVEL_RANK[level]) level = r.access_level;
    for (const p of r.permissions ?? DEFAULT_ROLE_PERMISSIONS[r.access_level]) permissions.add(p);
  }
  return { level, permissions: [...permissions], names: roles.map((r) => r.name) };
}
