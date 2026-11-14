import { fieldError } from "@raffle/shared";
import type { FieldError } from "@raffle/shared";

/** Back_Office roles (Requirement 19.2). */
export const ADMIN_ROLES = ["support", "compliance", "finance", "super_admin"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const BACK_OFFICE_ACTIONS = [
  "view_review_queue",
  "review_raffle",
  "suspend",
  "reinstate",
  "view_finance",
  "retry_refund",
  "retry_payout",
  "view_reports",
  "respond_report",
  "view_cases",
  "respond_case",
  "configure",
] as const;
export type BackOfficeAction = (typeof BACK_OFFICE_ACTIONS)[number];

/** Actions each role may perform (Requirements 19.2 to 19.10). Super Admin may perform every action. */
export const ROLE_ACTIONS: Readonly<Record<AdminRole, readonly BackOfficeAction[]>> = {
  support: ["view_reports", "respond_report", "view_cases", "respond_case"],
  compliance: [
    "view_review_queue",
    "review_raffle",
    "suspend",
    "reinstate",
    "view_reports",
    "respond_report",
    "view_cases",
    "respond_case",
  ],
  finance: ["view_finance", "retry_refund", "retry_payout"],
  super_admin: BACK_OFFICE_ACTIONS,
};

export function isAdminRole(r: string): r is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(r);
}

/** Whether any assigned role permits the action. Unknown roles grant nothing (Requirement 19.3). */
export function can(roles: readonly string[], action: BackOfficeAction): boolean {
  return roles.some((r) => isAdminRole(r) && ROLE_ACTIONS[r].includes(action));
}

/** Each Admin must be assigned at least one valid Back_Office role (Requirement 19.2). */
export function validateRoleAssignment(roles: readonly string[]): FieldError | null {
  return roles.length > 0 && roles.every(isAdminRole) ? null : fieldError("roles", "required");
}

export const REASON_MAX = 1000;

/** A reason must hold 1 to `max` characters once trimmed (Requirements 15.10, 15.11, 19.4, 19.5, 19.8). */
export function validateReason(reason: string, max: 1000 | 500 = REASON_MAX): FieldError | null {
  const n = [...reason.trim()].length;
  return n >= 1 && n <= max ? null : fieldError("reason", "length", { min: 1, max });
}

/** The caller's session as seen by the Back_Office. */
export interface AdminSession {
  userId: string;
  roles: readonly string[];
  /** True only after multi-factor authentication completed in the current session (Requirement 19.1). */
  mfaCompleted: boolean;
}

export type AccessError = { kind: "access_denied" } | { kind: "insufficient_permissions" };

/**
 * Admin gate. A caller that is not an Admin, or has not completed MFA in this session, is denied
 * before any Back_Office data is read (Requirement 19.1).
 */
export function authorize(
  session: AdminSession | null | undefined,
  action: BackOfficeAction,
): AccessError | null {
  if (!session || !session.mfaCompleted || !session.roles.some(isAdminRole)) {
    return { kind: "access_denied" };
  }
  return can(session.roles, action) ? null : { kind: "insufficient_permissions" };
}
