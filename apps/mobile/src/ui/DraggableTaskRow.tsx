import type { ReactNode } from "react";
import type { Task } from "@atlastodo/client-core";

/**
 * Wrap a task row so it can be dropped onto another row to nest it. A native no-op passthrough:
 * on a phone nesting is touch drag-to-indent and the detail composer. Metro resolves
 * `DraggableTaskRow.web.tsx` for the browser, which wires the real drag source and drop target.
 */
export function DraggableTaskRow({
  children,
}: {
  task: Task;
  onReparentDrop: (draggedId: string, target: Task) => void;
  children: ReactNode;
}) {
  return <>{children}</>;
}
