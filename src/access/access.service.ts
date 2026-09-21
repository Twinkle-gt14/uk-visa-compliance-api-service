import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "crypto";
import type { PoolClient } from "pg";
import { authPool, withTenant } from "../db";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSION_IDS, PERMISSIONS, SYSTEM_ROLES, combineRoles, type AccessLevel } from "./permissions";

export interface RoleDto {
  id: string;
  name: string;
  description: string;
  accessLevel: AccessLevel;
  permissions: string[];
  isSystem: boolean;
  userCount: number;
}

export interface UserRoleRef {
  id: string;
  name: string;
  accessLevel: AccessLevel;
}

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  /** All the user's roles, the first being their primary one. Their permissions are the combination. */
  roles: UserRoleRef[];
  roleName: string;
  accessLevel: AccessLevel;
  /** The employee record this login belongs to (needed for self-service features). */
  employeeId: string | null;
  employeeName: string | null;
  employeeLabel: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
}

export interface EmployeeOption {
  id: string;
  name: string;
  label: string;
  /** The login this employee currently has, if any. */
  linkedEmail: string | null;
  linkedUserId: string | null;
}

const LEVEL_ORDER: Record<AccessLevel, number> = { admin: 0, hr: 1, employee: 2 };

/** Which permissions a role of each access level may hold. */
function allowedPermissions(level: AccessLevel): Set<string> {
  return new Set(DEFAULT_ROLE_PERMISSIONS[level]);
}

function temporaryPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const all = upper + lower + digits;
  const pick = (set: string) => set[randomBytes(1)[0] % set.length];
  const chars = [pick(upper), pick(lower), pick(digits)];
  while (chars.length < 12) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function rowToRole(r: any): RoleDto {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? "",
    accessLevel: r.access_level,
    permissions: r.permissions ?? [],
    isSystem: !!r.is_system,
    userCount: Number(r.user_count ?? 0),
  };
}

/** How many users hold a role, as a primary or an additional role. */
const USER_COUNT_SQL = `(SELECT COUNT(DISTINCT c.id) FROM security.credential c
   WHERE c.role_id = r.id OR EXISTS (SELECT 1 FROM security.credential_role cr WHERE cr.credential_id = c.id AND cr.role_id = r.id)) AS user_count`;

@Injectable()
export class AccessService {
  /** The permission catalogue, with which kinds of role are allowed to hold each one. */
  listPermissions() {
    return PERMISSIONS;
  }

  /** Makes sure the three built-in roles exist for this tenant (a tenant created after the migration). */
  private async ensureSystemRoles(tenantId: string): Promise<void> {
    for (const r of SYSTEM_ROLES) {
      await authPool.query(
        `INSERT INTO security.role (tenant_id, name, description, access_level, permissions, is_system)
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (tenant_id, lower(name)) DO NOTHING`,
        [tenantId, r.name, r.description, r.accessLevel, DEFAULT_ROLE_PERMISSIONS[r.accessLevel]]
      );
    }
  }

  // ---------------------------------------------------------------- roles

  async listRoles(tenantId: string): Promise<RoleDto[]> {
    await this.ensureSystemRoles(tenantId);
    const result = await authPool.query(`SELECT r.*, ${USER_COUNT_SQL} FROM security.role r WHERE r.tenant_id = $1`, [tenantId]);
    return result.rows
      .map(rowToRole)
      .sort((a, b) => LEVEL_ORDER[a.accessLevel] - LEVEL_ORDER[b.accessLevel] || Number(b.isSystem) - Number(a.isSystem) || a.name.localeCompare(b.name));
  }

  private cleanRoleInput(input: { permissions?: string[] }, level: AccessLevel) {
    const permissions = [...new Set((input.permissions ?? []).filter((p) => PERMISSION_IDS.has(p)))];
    const allowed = allowedPermissions(level);
    const notAllowed = permissions.filter((p) => !allowed.has(p));
    if (notAllowed.length) {
      throw new BadRequestException(`A ${level === "employee" ? "self-service (employee)" : "staff (HR)"} role can't include: ${notAllowed.join(", ")}.`);
    }
    return permissions;
  }

  async createRole(tenantId: string, input: { name: string; description?: string; accessLevel: string; permissions: string[] }): Promise<RoleDto> {
    const name = (input.name ?? "").trim();
    if (!name) throw new BadRequestException("Role name is required.");
    if (name.length > 60) throw new BadRequestException("Role name is too long (60 characters max).");
    if (input.accessLevel !== "hr" && input.accessLevel !== "employee") {
      throw new BadRequestException("A new role must be a staff (HR) role or an employee role. There is one Admin role.");
    }
    const level = input.accessLevel as AccessLevel;
    const permissions = this.cleanRoleInput(input, level);
    await this.ensureSystemRoles(tenantId);
    const exists = await authPool.query("SELECT 1 FROM security.role WHERE tenant_id = $1 AND lower(name) = lower($2)", [tenantId, name]);
    if (exists.rowCount) throw new ConflictException("A role with that name already exists.");
    const result = await authPool.query(
      `INSERT INTO security.role (tenant_id, name, description, access_level, permissions, is_system)
       VALUES ($1, $2, $3, $4, $5, false) RETURNING *, 0 AS user_count`,
      [tenantId, name, (input.description ?? "").trim() || null, level, permissions]
    );
    return rowToRole(result.rows[0]);
  }

  async updateRole(tenantId: string, id: string, input: { name?: string; description?: string; permissions?: string[] }): Promise<RoleDto> {
    const found = await authPool.query("SELECT * FROM security.role WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
    if (!found.rowCount) throw new NotFoundException("Role not found.");
    const role = found.rows[0];
    if (role.access_level === "admin") throw new BadRequestException("The Admin role can't be changed.");

    let name = role.name;
    if (input.name !== undefined && !role.is_system) {
      name = input.name.trim();
      if (!name) throw new BadRequestException("Role name is required.");
      if (name.length > 60) throw new BadRequestException("Role name is too long (60 characters max).");
      const clash = await authPool.query("SELECT 1 FROM security.role WHERE tenant_id = $1 AND lower(name) = lower($2) AND id <> $3", [tenantId, name, id]);
      if (clash.rowCount) throw new ConflictException("A role with that name already exists.");
    }
    const permissions = input.permissions !== undefined ? this.cleanRoleInput(input, role.access_level) : role.permissions;
    const description = input.description !== undefined ? input.description.trim() || null : role.description;

    await authPool.query("UPDATE security.role SET name = $1, description = $2, permissions = $3 WHERE id = $4 AND tenant_id = $5", [name, description, permissions, id, tenantId]);
    return (await this.listRoles(tenantId)).find((r) => r.id === id)!;
  }

  async deleteRole(tenantId: string, id: string): Promise<{ id: string }> {
    const found = await authPool.query(`SELECT r.*, ${USER_COUNT_SQL} FROM security.role r WHERE r.id = $1 AND r.tenant_id = $2`, [id, tenantId]);
    if (!found.rowCount) throw new NotFoundException("Role not found.");
    if (found.rows[0].is_system) throw new BadRequestException("Built-in roles can't be deleted.");
    if (Number(found.rows[0].user_count) > 0) throw new ConflictException("Users are still assigned to this role - move them to another role first.");
    await authPool.query("DELETE FROM security.role WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
    return { id };
  }

  // ---------------------------------------------------------------- users

  private async employeeNames(tenantId: string, ids: string[]): Promise<Map<string, { name: string; label: string }>> {
    const map = new Map<string, { name: string; label: string }>();
    if (!ids.length) return map;
    const rows = await withTenant(tenantId, async (client) => {
      const r = await client.query(
        "SELECT id, first_name, middle_name, last_name, employee_id_label FROM employee.employee_master WHERE id = ANY($1::uuid[])",
        [ids]
      );
      return r.rows;
    });
    for (const r of rows) {
      map.set(r.id, { name: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(" "), label: r.employee_id_label ?? "" });
    }
    return map;
  }

  private rowToUser(r: any, names: Map<string, { name: string; label: string }>): UserDto {
    const roles: UserRoleRef[] = (r.roles ?? []).map((x: any) => ({ id: x.id, name: x.name, accessLevel: x.access_level }));
    const legacyLevel: AccessLevel = r.role === "employee" ? "employee" : "hr";
    const effective = roles.length ? combineRoles(roles.map((x) => ({ access_level: x.accessLevel, permissions: [], name: x.name }))) : null;
    const emp = r.employee_id ? names.get(r.employee_id) : undefined;
    return {
      id: r.id,
      email: r.email,
      displayName: r.display_name || "",
      roles,
      roleName: roles.length ? roles.map((x) => x.name).join(" + ") : legacyLevel === "employee" ? "Employee" : "HR",
      accessLevel: effective?.level ?? legacyLevel,
      employeeId: r.employee_id ?? null,
      employeeName: emp?.name ?? null,
      employeeLabel: emp?.label ?? null,
      isActive: r.is_active !== false,
      mustChangePassword: !!r.must_change_password,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? ""),
    };
  }

  private static readonly USER_SELECT = `
    SELECT c.*,
      (SELECT json_agg(json_build_object('id', r.id, 'name', r.name, 'access_level', r.access_level) ORDER BY (r.id = c.role_id) DESC, r.name)
         FROM security.role r
         WHERE r.id = c.role_id OR r.id IN (SELECT cr.role_id FROM security.credential_role cr WHERE cr.credential_id = c.id)) AS roles
    FROM security.credential c`;

  private async fetchUser(tenantId: string, id: string): Promise<UserDto> {
    const result = await authPool.query(`${AccessService.USER_SELECT} WHERE c.id = $1 AND c.tenant_id = $2`, [id, tenantId]);
    if (!result.rowCount) throw new NotFoundException("User not found.");
    const row = result.rows[0];
    return this.rowToUser(row, await this.employeeNames(tenantId, row.employee_id ? [row.employee_id] : []));
  }

  async listUsers(tenantId: string): Promise<UserDto[]> {
    await this.ensureSystemRoles(tenantId);
    // Only logins that can actually sign in: active, and (for an employee's own login) the employee is Active.
    const result = await authPool.query(`${AccessService.USER_SELECT} WHERE c.tenant_id = $1 AND c.is_active ORDER BY lower(c.email)`, [tenantId]);
    const empIds: string[] = result.rows.map((r) => r.employee_id ?? r.source_employee_id).filter(Boolean);
    const names = await this.employeeNames(tenantId, empIds);
    const activeEmployees = new Set<string>();
    if (empIds.length) {
      const st = await withTenant(tenantId, async (client) => {
        const r = await client.query("SELECT id FROM employee.employee_master WHERE id = ANY($1::uuid[]) AND record_status = 'Active' AND NOT is_deleted", [empIds]);
        return r.rows;
      });
      for (const r of st) activeEmployees.add(r.id);
    }
    return result.rows.filter((r) => { const link = r.employee_id ?? r.source_employee_id; return !link || activeEmployees.has(link); }).map((r) => this.rowToUser(r, names));
  }

  /** Active, onboarded employees a login can be linked to, with whichever login they already have. */
  async listEmployees(tenantId: string): Promise<EmployeeOption[]> {
    const employees = await withTenant(tenantId, async (client) => {
      const r = await client.query(
        `SELECT id, first_name, middle_name, last_name, employee_id_label FROM employee.employee_master
         WHERE is_onboarded AND record_status = 'Active' AND NOT is_deleted ORDER BY first_name, last_name`
      );
      return r.rows;
    });
    const links = await authPool.query("SELECT id, email, employee_id FROM security.credential WHERE tenant_id = $1 AND employee_id IS NOT NULL", [tenantId]);
    const byEmployee = new Map<string, { id: string; email: string }>(links.rows.map((l) => [l.employee_id, { id: l.id, email: l.email }]));
    return employees.map((e) => ({
      id: e.id,
      name: [e.first_name, e.middle_name, e.last_name].filter(Boolean).join(" "),
      label: e.employee_id_label ?? "",
      linkedEmail: byEmployee.get(e.id)?.email ?? null,
      linkedUserId: byEmployee.get(e.id)?.id ?? null,
    }));
  }

  private async activeAdminCount(tenantId: string, excludingUserId?: string): Promise<number> {
    const r = await authPool.query(
      `SELECT COUNT(DISTINCT c.id) AS n FROM security.credential c
       WHERE c.tenant_id = $1 AND c.is_active AND ($2::uuid IS NULL OR c.id <> $2::uuid)
         AND EXISTS (SELECT 1 FROM security.role r
                     WHERE r.access_level = 'admin'
                       AND (r.id = c.role_id OR EXISTS (SELECT 1 FROM security.credential_role cr WHERE cr.credential_id = c.id AND cr.role_id = r.id)))`,
      [tenantId, excludingUserId ?? null]
    );
    return Number(r.rows[0].n);
  }

  /** Loads and checks the chosen roles: they must all exist in the tenant, and the first is the primary one. */
  private async loadRoles(tenantId: string, roleIds: unknown): Promise<{ id: string; name: string; access_level: AccessLevel }[]> {
    if (!Array.isArray(roleIds) || roleIds.length === 0) throw new BadRequestException("Choose at least one role.");
    const unique = [...new Set(roleIds.filter((x): x is string => typeof x === "string"))];
    const found = await authPool.query("SELECT id, name, access_level FROM security.role WHERE tenant_id = $1 AND id = ANY($2::uuid[])", [tenantId, unique]);
    if (found.rowCount !== unique.length) throw new BadRequestException("One of the chosen roles doesn't exist.");
    const byId = new Map<string, { id: string; name: string; access_level: AccessLevel }>(found.rows.map((r) => [r.id, r]));
    return unique.map((id) => byId.get(id)!);
  }

  /**
   * Checks an employee can be linked to a login and, if that employee currently has a separate employee-only
   * login, moves them onto this one: the old login is deactivated and released. Runs in the caller's
   * transaction so the move and the rest of the save succeed or fail together.
   */
  private async linkEmployee(client: PoolClient, tenantId: string, employeeId: string, forUserId: string | null): Promise<void> {
    const emp = await withTenant(tenantId, async (c) => {
      const r = await c.query("SELECT record_status, is_onboarded, is_deleted FROM employee.employee_master WHERE id = $1", [employeeId]);
      return r.rows[0];
    });
    if (!emp || emp.is_deleted) throw new BadRequestException("That employee doesn't exist.");
    if (emp.record_status !== "Active" || !emp.is_onboarded) throw new BadRequestException("Only an Active, onboarded employee can be linked to a login.");

    const holder = await client.query(
      `SELECT c.id, c.email,
              (SELECT bool_and(r.access_level = 'employee') FROM security.role r
                 WHERE r.id = c.role_id OR r.id IN (SELECT cr.role_id FROM security.credential_role cr WHERE cr.credential_id = c.id)) AS employee_only
       FROM security.credential c WHERE c.tenant_id = $1 AND c.employee_id = $2`,
      [tenantId, employeeId]
    );
    const other = holder.rows[0];
    if (!other || other.id === forUserId) return;
    if (!other.employee_only && other.employee_only !== null) {
      throw new ConflictException(`That employee is already linked to ${other.email}.`);
    }
    await client.query("UPDATE security.credential SET employee_id = NULL, is_active = false WHERE id = $1", [other.id]);
  }

  private legacyRoleText(levels: AccessLevel[]): string {
    return levels.every((l) => l === "employee") ? "employee" : "hr_admin";
  }

  /** Lower-case, dot-free slug of a role name, used as the login prefix (HR -> "hr"). */
  private static slug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "user";
  }

  /**
   * Gives an employee a login for a role. The login id is "<role>.<employee id>@<company domain>" (e.g.
   * hr.e000020@abc.com), separate from the employee's own login, and carries only this role's permissions.
   * The employee's own login is created at onboarding, so the Employee role can't be attached here.
   */
  async attachUser(tenantId: string, roleId: string, employeeId: string): Promise<{ user: UserDto; temporaryPassword: string }> {
    await this.ensureSystemRoles(tenantId);
    const [role] = await this.loadRoles(tenantId, [roleId]);
    if (role.access_level === "employee") {
      throw new BadRequestException("Employee logins are created automatically when an employee is onboarded.");
    }
    const emp = await withTenant(tenantId, async (c) => {
      const r = await c.query("SELECT first_name, middle_name, last_name, employee_id_label, record_status, is_onboarded, is_deleted FROM employee.employee_master WHERE id = $1", [employeeId]);
      return r.rows[0];
    });
    if (!emp || emp.is_deleted) throw new BadRequestException("That employee doesn't exist.");
    if (emp.record_status !== "Active" || !emp.is_onboarded) throw new BadRequestException("Only an Active, onboarded employee can be given a login.");
    const prof = await authPool.query("SELECT email_domain FROM reference.employer_profile WHERE tenant_id = $1", [tenantId]);
    const domain: string | null = prof.rows[0]?.email_domain || null;
    if (!domain) throw new BadRequestException("Set the company email domain in Employer Settings first.");

    const email = `${AccessService.slug(role.name)}.${String(emp.employee_id_label).toLowerCase()}@${domain.toLowerCase()}`;
    const displayName = [emp.first_name, emp.middle_name, emp.last_name].filter(Boolean).join(" ");
    const password = temporaryPassword();
    const existing = await authPool.query("SELECT id, is_active FROM security.credential WHERE lower(email) = $1", [email]);
    let id: string;
    if (existing.rowCount) {
      if (existing.rows[0].is_active) throw new ConflictException(`${displayName} already has the ${role.name} login ${email}.`);
      id = existing.rows[0].id; // detached earlier - bring the same login back
      await authPool.query(
        "UPDATE security.credential SET is_active = true, role_id = $1, role = $2, display_name = $3, password_hash = crypt($4, gen_salt('bf')), must_change_password = true, source_employee_id = $6 WHERE id = $5",
        [role.id, this.legacyRoleText([role.access_level]), displayName || null, password, id, employeeId]
      );
      await authPool.query("DELETE FROM security.credential_role WHERE credential_id = $1", [id]);
    } else {
      const inserted = await authPool.query(
        `INSERT INTO security.credential (tenant_id, email, password_hash, role, must_change_password, role_id, display_name, source_employee_id)
         VALUES ($1, $2, crypt($3, gen_salt('bf')), $4, true, $5, $6, $7) RETURNING id`,
        [tenantId, email, password, this.legacyRoleText([role.access_level]), role.id, displayName || null, employeeId]
      );
      id = inserted.rows[0].id;
    }
    return { user: await this.fetchUser(tenantId, id), temporaryPassword: password };
  }

  /** Takes a user off a role: their login is deactivated (it can be attached again later). */
  async detachUser(tenantId: string, actingUserId: string, roleId: string, userId: string): Promise<UserDto> {
    const user = await this.fetchUser(tenantId, userId);
    if (!user.roles.some((r) => r.id === roleId)) throw new NotFoundException("That user isn't attached to this role.");
    return this.updateUser(tenantId, actingUserId, userId, { isActive: false });
  }

  async updateUser(
    tenantId: string,
    actingUserId: string,
    id: string,
    input: { roleIds?: string[]; employeeId?: string | null; isActive?: boolean; displayName?: string }
  ): Promise<UserDto> {
    const current = await this.fetchUser(tenantId, id);
    const rolesChanged = input.roleIds !== undefined;
    const roles = rolesChanged
      ? await this.loadRoles(tenantId, input.roleIds)
      : current.roles.map((r) => ({ id: r.id, name: r.name, access_level: r.accessLevel }));
    const levels = roles.map((r) => r.access_level);
    const newLevel = combineRoles(roles.map((r) => ({ access_level: r.access_level, permissions: [], name: r.name }))).level;

    const newEmployeeId = input.employeeId === undefined ? current.employeeId : input.employeeId;
    if (levels.includes("employee") && !newEmployeeId) {
      throw new BadRequestException("Choose the employee this login belongs to - an employee role needs one for their own records.");
    }
    if (!levels.includes("employee") && !levels.some((l) => l !== "employee")) {
      throw new BadRequestException("Choose at least one role.");
    }
    const newActive = input.isActive !== undefined ? input.isActive : current.isActive;

    // Never leave the tenant without an active Admin, and never let someone lock themselves out.
    const wasActiveAdmin = current.accessLevel === "admin" && current.isActive;
    const staysActiveAdmin = newLevel === "admin" && newActive;
    if (wasActiveAdmin && !staysActiveAdmin && (await this.activeAdminCount(tenantId, id)) === 0) {
      throw new BadRequestException("There must always be at least one active Admin.");
    }
    if (id === actingUserId && !newActive) throw new BadRequestException("You can't deactivate your own account.");
    if (id === actingUserId && newLevel !== "admin") throw new BadRequestException("You can't remove your own Admin access.");

    const displayName = input.displayName !== undefined ? input.displayName.trim() || null : current.displayName || null;
    const client = await authPool.connect();
    try {
      await client.query("BEGIN");
      if (newEmployeeId && newEmployeeId !== current.employeeId) await this.linkEmployee(client, tenantId, newEmployeeId, id);
      await client.query(
        "UPDATE security.credential SET role_id = $1, role = $2, is_active = $3, display_name = $4, employee_id = $5 WHERE id = $6 AND tenant_id = $7",
        [roles[0].id, this.legacyRoleText(levels), newActive, displayName, newEmployeeId ?? null, id, tenantId]
      );
      if (rolesChanged) {
        await client.query("DELETE FROM security.credential_role WHERE credential_id = $1", [id]);
        for (const extra of roles.slice(1)) {
          await client.query("INSERT INTO security.credential_role (credential_id, role_id) VALUES ($1, $2)", [id, extra.id]);
        }
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return this.fetchUser(tenantId, id);
  }

  async resetPassword(tenantId: string, id: string): Promise<{ temporaryPassword: string }> {
    await this.fetchUser(tenantId, id);
    const password = temporaryPassword();
    await authPool.query("UPDATE security.credential SET password_hash = crypt($1, gen_salt('bf')), must_change_password = true WHERE id = $2 AND tenant_id = $3", [password, id, tenantId]);
    return { temporaryPassword: password };
  }
}
