import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { resolveProjectColor } from "@atlastodo/shared";
import { HabitDetailScreen } from "../../../src/screens/HabitDetailScreen";
import { HabitGroupDetailScreen } from "../../../src/screens/HabitGroupDetailScreen";
import { useHabits } from "../../../src/hooks/useHabits";
import { useFeature } from "../../../src/hooks/useFeature";
import { projectIconFor } from "../../../src/ui/projectIcons";
import { useHeaderTitle } from "../../../src/ui/useHeaderTitle";
import { ScreenFocusBoundary } from "../../../src/ui/ScreenFocusBoundary";

/**
 * One habit in full, as a drawer screen rather than pushed over the shell (as the project route):
 * a habit is edited repeatedly, so keeping the sidebar or menu bar beats a back button; the task
 * detail stays pushed because it is a focused editor you leave at once.
 *
 * Gated behind the `habits` flag, so a deep link into a disabled feature lands on Today.
 */
export default function HabitRoute() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const enabled = useFeature("habits");
  const { habits, habitGroups, archivedHabits } = useHabits();
  // Groups share the habit id space and this route.
  const habit = [...habits, ...habitGroups, ...archivedHabits].find((h) => h.id === id);

  useHeaderTitle({
    icon: projectIconFor(habit?.icon),
    title: habit?.name ?? t("nav.habits"),
    color: habit ? resolveProjectColor(habit) : undefined,
  });

  if (!enabled) return <Redirect href="/today" />;
  if (typeof id !== "string") return null;

  // A drawer screen is not pushed, so leaving navigates to the list rather than popping.
  const leave = () => router.replace("/habits");

  return (
    <ScreenFocusBoundary>
      {habit?.kind === "group" ? (
        <HabitGroupDetailScreen
          groupId={id}
          onOpenHabit={(member) => router.push(`/habit/${member.id}`)}
          onLeave={leave}
        />
      ) : (
        <HabitDetailScreen
          habitId={id}
          onOpenGroup={(groupId) => router.push(`/habit/${groupId}`)}
          onLeave={leave}
        />
      )}
    </ScreenFocusBoundary>
  );
}
