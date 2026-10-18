import { useEffect } from "react";
import { Platform, Pressable, Text, View, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { ACCENTS } from "@atlastodo/shared";
import { usePreferences } from "../hooks/usePreferences";
import { haptics } from "../lib/haptics";

/**
 * A labelled on/off switch with smooth animated transitions.
 */
export function Toggle({
  label,
  description,
  value,
  onValueChange,
  accessibilityLabel,
  className,
}: {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  accessibilityLabel?: string;
  className?: string;
}) {
  const isWeb = Platform.OS === "web";
  const { accent } = usePreferences();
  const accentHex = ACCENTS[accent]?.[600] ?? "#4f46e5";
  const a11yLabel = accessibilityLabel ?? label;

  const offset = useSharedValue(value ? 22 : 2);

  useEffect(() => {
    offset.value = withTiming(value ? 22 : 2, { duration: 200 });
  }, [value, offset]);

  const animatedThumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.value }],
  }));

  return (
    <View
      className={
        "flex-row items-center justify-between gap-4 " +
        (className !== undefined
          ? className
          : "border-t border-neutral-100 py-3 dark:border-neutral-900")
      }
    >
      <View className="flex-1 gap-0.5">
        <Text
          className={
            "font-medium text-neutral-900 dark:text-neutral-100 " + (isWeb ? "text-sm" : "text-lg")
          }
        >
          {label}
        </Text>
        {description != null && (
          <Text className={"text-neutral-500 " + (isWeb ? "text-xs" : "text-base")}>
            {description}
          </Text>
        )}
      </View>
      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: value }}
        accessibilityLabel={a11yLabel}
        onPress={() => {
          haptics.selection();
          onValueChange(!value);
        }}
        {...({ value, onValueChange } as object)}
        style={[
          {
            width: 44,
            height: 24,
            borderRadius: 12,
            backgroundColor: value ? accentHex : undefined,
          },
          isWeb ? ({ transition: "background-color 200ms ease" } as ViewStyle) : undefined,
        ]}
        className={
          "relative shrink-0 rounded-full justify-center transition-colors duration-200 web:cursor-pointer " +
          (value ? "" : "bg-neutral-300 dark:bg-neutral-700")
        }
      >
        <Animated.View
          style={[
            {
              position: "absolute",
              top: 2,
              left: 0,
              width: 20,
              height: 20,
              borderRadius: 10,
              backgroundColor: "#ffffff",
            },
            Platform.select({
              web: {
                boxShadow: "0 1px 2px rgba(0, 0, 0, 0.2)",
              },
              ios: {
                shadowColor: "#000",
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: 0.2,
                shadowRadius: 1.5,
              },
              android: {
                elevation: 2,
              },
              default: {},
            }),
            animatedThumbStyle,
          ]}
        />
      </Pressable>
    </View>
  );
}
