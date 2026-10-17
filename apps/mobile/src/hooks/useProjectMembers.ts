import { useCallback, useMemo } from "react";
import { isOwnerDeletionScheduled, isProjectOwner, toMember, type Member } from "@atlastodo/shared";
import { useAuth } from "../auth/AuthContext";
import { useStore } from "../data/StoreProvider";

/**
 * Shared-project members. The server authors `project_member` entities into each member's sync
 * partition, so this is a pure read; membership is mutated through the sharing REST endpoints (see
 * `ShareDialog`), never the store.
 */

export interface UseProjectMembers {
  members: Member[];
  /** Active members of a project (the assignable set). */
  forProject: (projectId: string) => Member[];
  /** Look up a member by user id (for showing an assignee's / commenter's name). */
  byUserId: (userId: string) => Member | undefined;
  /**
   * Whether the current user may act as owner of a project — the gate for deleting a shared project.
   * An unshared (private) project has no member rows, so its creator is the implicit owner.
   */
  isOwner: (projectId: string) => boolean;
  /**
   * Whether the project's active owner(s) are scheduled for deletion.
   */
  isOwnerDeletionScheduled: (projectId: string) => boolean;
  /**
   * Claim ownership of a project whose active owner(s) are scheduled for deletion.
   */
  claimOwnership: (projectId: string) => Promise<void>;
}

export function useProjectMembers(): UseProjectMembers {
  const { store, version, kick } = useStore();
  const { api, session } = useAuth();
  const myId = session?.user.id;

  const members = useMemo(
    () => store.list("project_member").map((e) => toMember(e.id, e.fields)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, version],
  );

  const forProject = useCallback(
    (projectId: string) =>
      members
        .filter((m) => m.project_id === projectId && m.state === "active")
        .sort(
          (a, b) => a.display_name.localeCompare(b.display_name) || a.email.localeCompare(b.email),
        ),
    [members],
  );

  const byUserId = useCallback(
    (userId: string) => members.find((m) => m.user_id === userId),
    [members],
  );

  const isOwner = useCallback(
    (projectId: string) => isProjectOwner(members, projectId, myId),
    [members, myId],
  );

  const isOwnerDeletionScheduledCb = useCallback(
    (projectId: string) => isOwnerDeletionScheduled(members, projectId),
    [members],
  );

  const claimOwnership = useCallback(
    async (projectId: string) => {
      await api.claimProjectOwnership(projectId);
      kick();
    },
    [api, kick],
  );

  return {
    members,
    forProject,
    byUserId,
    isOwner,
    isOwnerDeletionScheduled: isOwnerDeletionScheduledCb,
    claimOwnership,
  };
}
