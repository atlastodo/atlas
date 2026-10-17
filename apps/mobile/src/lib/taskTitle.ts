import type { TFunction } from "i18next";
import type { Task } from "@atlastodo/client-core";

/**
 * The title to show for a task. A task this device cannot decrypt has a placeholder "" title, which
 * rendered as a blank row, chip or label; it reads as the "Encrypted task" placeholder instead. Every
 * place that shows a task's title goes through this, so none can be missed.
 */
export function displayTitle(task: Pick<Task, "title" | "locked">, t: TFunction): string {
  return task.locked ? t("task.lockedTitle") : task.title;
}
