import { useCallback, useMemo } from "react";
import { isTaskLocked, isTrashed, softDelete, toComment, type Comment } from "@atlastodo/shared";
import { useStore } from "../data/StoreProvider";

/**
 * Task comments: `comment` entities in the shared store. On a shared project the server fans them
 * out to all members and checks roles (commenter+), so the client writes optimistically. Ids come
 * from `store.newEntityId()`, not `crypto.randomUUID()` (Hermes has none).
 */

export interface UseComments {
  comments: Comment[];
  /** Comments on a task, oldest first. */
  forTask: (taskId: string) => Comment[];
  /** Add a comment; its id, or null on a task this device cannot decrypt (it is read-only here). */
  addComment: (taskId: string, authorId: string, body: string) => string | null;
  removeComment: (id: string) => () => void;
}

export function useComments(): UseComments {
  const { store, version, kick } = useStore();

  const comments = useMemo(
    () =>
      store
        .list("comment")
        .filter((e) => !isTrashed(e.fields))
        .map((e) => toComment(e.id, e.fields)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, version],
  );

  const forTask = useCallback(
    (taskId: string) =>
      comments.filter((c) => c.task_id === taskId).sort((a, b) => a.created_at - b.created_at),
    [comments],
  );

  const addComment = useCallback(
    (taskId: string, authorId: string, body: string) => {
      if (isTaskLocked(store, taskId)) return null;
      const id = store.newEntityId();
      store.set("comment", id, "task_id", taskId);
      store.set("comment", id, "author_id", authorId);
      store.set("comment", id, "body", body);
      store.set("comment", id, "created_at", Date.now());
      kick();
      return id;
    },
    [store, kick],
  );

  const removeComment = useCallback(
    (id: string) => softDelete(store, kick, "comment", id),
    [store, kick],
  );

  return { comments, forTask, addComment, removeComment };
}
