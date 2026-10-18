import { Pressable, Text, View } from "react-native";
import { PROJECT_COLORS, PROJECT_ICON_NAMES } from "@atlastodo/shared";
import { PROJECT_ICONS } from "./projectIcons";
import { Check } from "./icons";

/** The icon grid + colour row shared by the project and saved-filter style sheets; both carry the same `icon`/`color` fields. */
export interface StylePickerProps {
  iconLabel: string;
  colorLabel: string;
  selectedIcon: string | undefined;
  defaultIcon: string;
  selectedColor: string;
  onSetIcon: (icon: string) => void;
  onSetColor: (color: string) => void;
}

export function StylePicker({
  iconLabel,
  colorLabel,
  selectedIcon,
  defaultIcon,
  selectedColor,
  onSetIcon,
  onSetColor,
}: StylePickerProps) {
  // Lead with the subject's default icon, then the rest in canonical order.
  const iconNames = [defaultIcon, ...PROJECT_ICON_NAMES.filter((n) => n !== defaultIcon)];
  return (
    <>
      <View className="gap-2">
        <Text className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {iconLabel}
        </Text>
        <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
          {iconNames.map((iconName) => {
            const Icon = PROJECT_ICONS[iconName]!;
            const active = selectedIcon === iconName;
            return (
              <Pressable
                key={iconName}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={iconName}
                onPress={() => onSetIcon(iconName)}
                // Tinted in the subject's colour; inline style because the colour is a runtime hex.
                style={
                  active
                    ? { borderColor: selectedColor, backgroundColor: selectedColor + "33" }
                    : undefined
                }
                className={
                  "h-10 w-10 items-center justify-center rounded-md border-2 " +
                  (active ? "" : "border-neutral-200 dark:border-neutral-800")
                }
              >
                <Icon
                  size={18}
                  color={active ? selectedColor : undefined}
                  className={active ? undefined : "text-neutral-700 dark:text-neutral-200"}
                />
              </Pressable>
            );
          })}
        </View>
      </View>

      <View className="gap-2">
        <Text className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {colorLabel}
        </Text>
        <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
          {PROJECT_COLORS.map((swatch) => {
            const active = selectedColor.toLowerCase() === swatch.toLowerCase();
            return (
              <Pressable
                key={swatch}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={swatch}
                onPress={() => onSetColor(swatch)}
                style={{ backgroundColor: swatch }}
                className={
                  "h-8 w-8 items-center justify-center rounded-full border-2 " +
                  (active ? "border-neutral-900 dark:border-white" : "border-transparent")
                }
              >
                {active && <Check size={14} className="text-white" />}
              </Pressable>
            );
          })}
        </View>
      </View>
    </>
  );
}
