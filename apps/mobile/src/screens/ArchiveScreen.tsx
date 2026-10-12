import { ScrollView, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Task } from "@atlas/client-core";
import { useAuth } from "../auth/AuthContext";
import { useLocalTasks } from "../hooks/useLocalTasks";
import { useProjects } from "../hooks/useProjects";
import { useHabits } from "../hooks/useHabits";
import { projectIconFor } from "../ui/projectIcons";
import { EmptyState } from "../ui/EmptyState";
import { Archive, Folder, Hash, RotateCcw } from "../ui/icons";
import { displayTitle } from "../lib/taskTitle";

/**
 * The Archive: projects and tasks the user tucked away without deleting. Each restores to the
 * normal lists; restoring a project brings its tasks back via the read-time cascade. Distinct from
 * Trash (real deletions). A `ScrollView` of two short sections, since the view is low-volume.
 */
export function ArchiveScreen() {
  const { t } = useTranslation();
  const { session } = useAuth();
  const { archivedTasks, setArchived } = useLocalTasks(session?.user.id);
  const { archivedProjects, setProjectArchived } = useProjects();
  const { habitGroups, archivedHabits, setArchived: setHabitArchived } = useHabits();
  // A routine and a habit look identical in one list; the member's origin is what you need before restoring it.
  const archivedRoutines = archivedHabits.filter((h) => h.kind === "group");
  const archivedMembers = archivedHabits.filter((h) => h.kind !== "group");
  const routineName = (parentId: string | null) =>
    parentId === null
      ? undefined
      : (
          habitGroups.find((g) => g.id === parentId) ??
          archivedRoutines.find((g) => g.id === parentId)
        )?.name;

  if (archivedTasks.length === 0 && archivedProjects.length === 0 && archivedHabits.length === 0) {
    return (
      <EmptyState icon={Archive} title={t("archive.empty")} description={t("archive.emptyHint")} />
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-white dark:bg-zinc-950"
      contentContainerClassName="gap-6 p-4 web:mx-auto web:w-full web:max-w-2xl"
    >
      {archivedProjects.length > 0 && (
        <View className="gap-1.5">
          <Text className="mb-1 text-xs font-semibold uppercase text-neutral-500">
            {t("archive.projects")}
          </Text>
          {archivedProjects.map((p) => (
            <ArchiveRow
              key={p.id}
              title={p.name}
              // An archived folder is listed too; restoring it brings its subtree back through the read cascade.
              icon={
                p.kind === "folder" ? (
                  <Folder size={16} className="text-neutral-500" />
                ) : (
                  <Hash size={16} className="text-neutral-500" />
                )
              }
              restoreLabel={t("archive.restore")}
              onRestore={() => setProjectArchived(p.id, false)}
            />
          ))}
        </View>
      )}
      {archivedTasks.length > 0 && (
        <View className="gap-1.5">
          <Text className="mb-1 text-xs font-semibold uppercase text-neutral-500">
            {t("archive.tasks")}
          </Text>
          {archivedTasks.map((task: Task) => (
            <ArchiveRow
              key={task.id}
              title={displayTitle(task, t)}
              restoreLabel={t("archive.restore")}
              onRestore={() => setArchived(task, false)}
            />
          ))}
        </View>
      )}
      {archivedRoutines.length > 0 && (
        <View className="gap-1.5">
          <Text className="mb-1 text-xs font-semibold uppercase text-neutral-500">
            {t("archive.routines")}
          </Text>
          {archivedRoutines.map((group) => {
            const Icon = projectIconFor(group.icon);
            return (
              <ArchiveRow
                key={group.id}
                title={group.name}
                icon={<Icon size={16} color={group.color} />}
                restoreLabel={t("archive.restore")}
                onRestore={() => setHabitArchived(group.id, false)}
              />
            );
          })}
        </View>
      )}
      {archivedMembers.length > 0 && (
        <View className="gap-1.5">
          <Text className="mb-1 text-xs font-semibold uppercase text-neutral-500">
            {t("archive.habits")}
          </Text>
          {archivedMembers.map((habit) => {
            const Icon = projectIconFor(habit.icon);
            return (
              <ArchiveRow
                key={habit.id}
                title={habit.name}
                subtitle={routineName(habit.parent_id)}
                icon={<Icon size={16} color={habit.color} />}
                restoreLabel={t("archive.restore")}
                onRestore={() => setHabitArchived(habit.id, false)}
              />
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

function ArchiveRow({
  title,
  subtitle,
  icon,
  restoreLabel,
  onRestore,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  restoreLabel: string;
  onRestore: () => void;
}) {
  return (
    <View className="flex-row items-center justify-between gap-3 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800">
      <View className="min-w-0 flex-1 flex-row items-center gap-2">
        {icon}
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-sm text-neutral-700 dark:text-neutral-200">
            {title}
          </Text>
          {subtitle !== undefined && (
            <Text numberOfLines={1} className="text-xs text-neutral-500">
              {subtitle}
            </Text>
          )}
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={restoreLabel}
        onPress={onRestore}
        className="flex-row items-center gap-1 rounded-md border border-neutral-200 px-2.5 py-1.5 dark:border-neutral-800 web:cursor-pointer"
      >
        <RotateCcw size={14} className="text-neutral-500" />
        <Text className="text-xs text-neutral-500">{restoreLabel}</Text>
      </Pressable>
    </View>
  );
}
