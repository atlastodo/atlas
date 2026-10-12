import { Text } from "react-native";

/**
 * The small uppercase heading above a screen section (a habit's schedule, the stats breakdowns) --
 * shared by the habit detail, habit group and stats screens.
 */
export function SectionHeading({ children }: { children: string }) {
  return (
    <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
      {children}
    </Text>
  );
}
