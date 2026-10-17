import { useRef, type ReactNode } from "react";
import { View, type ViewInstance } from "react-native";
import { useTranslation } from "react-i18next";
import type { Task } from "@atlastodo/client-core";
import { useDragSource, useDropTarget } from "../hooks/useCardDnd";
import { useCanHover } from "../hooks/useCanHover";
import { GripVertical } from "./icons";

/**
 * The web drag-to-subtask wrapper: drag one row's grip onto another to make it a subtask (HTML5
 * drag via `useCardDnd`, like the board's `DraggableCard`). The drag source is a dedicated grip,
 * not the row: native HTML5 drag starts immediately and would fight the reorder pan. The whole row
 * is a drop target with a "nest here" ring. The reparent and cycle guard are the caller's
 * `onReparentDrop` -> `reparentTask`. Native uses the no-op `DraggableTaskRow.tsx`.
 */
export function DraggableTaskRow({
  task,
  onReparentDrop,
  children,
}: {
  task: Task;
  onReparentDrop: (draggedId: string, target: Task) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const rowRef = useRef<ViewInstance>(null);
  const handleRef = useRef<ViewInstance>(null);
  const over = useDropTarget(rowRef, (draggedId) => {
    if (draggedId !== task.id) onReparentDrop(draggedId, task);
  });
  const canHover = useCanHover();
  // `enabled` re-binds the grip when it mounts (a mouse attached after load).
  const dragging = useDragSource(handleRef, () => task.id, { enabled: canHover });

  return (
    <View ref={rowRef} className="group relative">
      {children}

      {/* Hover-only: on touch the grip would stick visible after a tap at the clipped right edge. */}
      {canHover && (
        <View
          ref={handleRef}
          accessible
          accessibilityLabel={t("task.dragToNest")}
          className={
            "absolute bottom-0 right-1 top-0 w-6 items-center justify-center opacity-0 group-hover:opacity-100 web:cursor-grab " +
            (dragging ? "opacity-100" : "")
          }
        >
          <GripVertical size={14} className="text-neutral-500" />
        </View>
      )}

      {over && !dragging && (
        <View
          style={{ pointerEvents: "none" }}
          className="absolute inset-0 rounded border-2 border-accent-500 bg-accent-50 dark:bg-accent-950"
        />
      )}
    </View>
  );
}
