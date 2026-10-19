import type { MemberRole } from "@atlastodo/client-core";

/**
 * A shared-project member as stored locally. The server authors `project_member` entities into each
 * member's sync partition, so the collaborator list and assignee picker read from the local store,
 * offline included. The client never writes them; membership changes go through the REST endpoints.
 */
export interface Member {
  id: string;
  project_id: string;
  user_id: string;
  email: string;
  display_name: string;
  role: MemberRole;
  state: "pending" | "active";
  deletion_scheduled?: boolean;
}

function role(v: unknown): MemberRole {
  return v === "owner" || v === "editor" || v === "commenter" ? v : "commenter";
}

export function toMember(id: string, fields: Record<string, unknown>): Member {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    id,
    project_id: str(fields.project_id),
    user_id: str(fields.user_id),
    email: str(fields.email),
    display_name: str(fields.display_name),
    role: role(fields.role),
    state: fields.state === "pending" ? "pending" : "active",
    deletion_scheduled: Boolean(fields.deletion_scheduled),
  };
}

/** Whether `projectId` is shared, has active owners, and all of them are scheduled for deletion. */
export function isOwnerDeletionScheduled(
  members: Pick<Member, "project_id" | "role" | "state" | "deletion_scheduled">[],
  projectId: string,
): boolean {
  const projectMembers = members.filter((m) => m.project_id === projectId);
  if (projectMembers.length === 0) return false;
  const activeOwners = projectMembers.filter((m) => m.role === "owner" && m.state === "active");
  if (activeOwners.length === 0) return false;
  return activeOwners.every((m) => Boolean(m.deletion_scheduled));
}

/**
 * Whether `userId` may act as owner of `projectId`, the gate for destructive actions (mirrors the
 * server's owner-only rule). A project with no member rows is private to its creator, who is the
 * implicit owner. Once shared, only an active `role: "owner"` qualifies; others can only leave.
 */
export function isProjectOwner(
  members: Pick<Member, "project_id" | "user_id" | "role" | "state">[],
  projectId: string,
  userId: string | undefined,
): boolean {
  const rows = members.filter((m) => m.project_id === projectId);
  if (rows.length === 0) return true; // unshared → implicit owner
  if (!userId) return false;
  return rows.some((m) => m.user_id === userId && m.state === "active" && m.role === "owner");
}

export function initialsOf(member: Pick<Member, "display_name" | "email">): string {
  const source = member.display_name.trim() || member.email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}
