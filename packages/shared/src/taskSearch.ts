/**
 * Task text search: case-insensitive substring match on title or notes, ranked with `scoreMatch`
 * to stay consistent with the command palette.
 */

import type { Task } from "@atlastodo/client-core";
import { scoreMatch } from "./fuzzy";

export interface TaskSearchHit {
  task: Task;
  field: "title" | "notes";
}

export const TASK_SEARCH_LIMIT = 20;

// A blank query matches nothing. Equal scores keep the caller's order; scope filtering is the caller's.
export function searchTasks(
  tasks: Task[],
  query: string,
  limit: number = TASK_SEARCH_LIMIT,
): TaskSearchHit[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const scored: { hit: TaskSearchHit; score: number; i: number }[] = [];
  for (const [i, task] of tasks.entries()) {
    if (task.title.toLowerCase().includes(q)) {
      // A substring is also a subsequence, so scoreMatch cannot miss here; +2 ranks any title hit
      // above any notes-only hit.
      const score = (scoreMatch(task.title, q) ?? 0) + 2;
      scored.push({ hit: { task, field: "title" }, score, i });
    } else if (task.notes.toLowerCase().includes(q)) {
      scored.push({ hit: { task, field: "notes" }, score: scoreMatch(task.notes, q) ?? 0, i });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((s) => s.hit);
}
