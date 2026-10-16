import { createContext, useContext, type ReactNode } from "react";
import { FlatList, ScrollView, type FlatListProps, type ScrollViewProps } from "react-native";
import { GestureDetector, type NativeGesture } from "react-native-gesture-handler";
import Animated, {
  type useAnimatedProps,
  type useAnimatedScrollHandler,
} from "react-native-reanimated";
import { cssInterop } from "nativewind";

/**
 * Scroll views inside a {@link BottomSheet}. They report their offset so a pull only drags the
 * sheet from the top of the content, and freeze while a pull drives the sheet, so pulling back up
 * raises it instead of scrolling. Outside a sheet (or on web) they are the plain components.
 */

export interface SheetScrollValue {
  scrollHandler: ReturnType<typeof useAnimatedScrollHandler>;
  nativeScrollGesture: NativeGesture;
  scrollAnimatedProps: ReturnType<typeof useAnimatedProps>;
}

const SheetScrollContext = createContext<SheetScrollValue | null>(null);

export function SheetScrollProvider({
  value,
  children,
}: {
  value: SheetScrollValue | null;
  children: ReactNode;
}) {
  return <SheetScrollContext.Provider value={value}>{children}</SheetScrollContext.Provider>;
}

// NativeWind only maps `className` on registered components; Reanimated's are not.
cssInterop(Animated.ScrollView, {
  className: "style",
  contentContainerClassName: "contentContainerStyle",
});
cssInterop(Animated.FlatList, {
  className: "style",
  contentContainerClassName: "contentContainerStyle",
});

export function SheetScrollView(
  props: ScrollViewProps & { className?: string; contentContainerClassName?: string },
) {
  const sheet = useContext(SheetScrollContext);
  if (!sheet) return <ScrollView {...props} />;
  return (
    <GestureDetector gesture={sheet.nativeScrollGesture}>
      <Animated.ScrollView
        {...props}
        scrollEventThrottle={16}
        onScroll={sheet.scrollHandler}
        animatedProps={sheet.scrollAnimatedProps}
      />
    </GestureDetector>
  );
}

export function SheetFlatList<T>(props: FlatListProps<T> & { className?: string }) {
  const sheet = useContext(SheetScrollContext);
  if (!sheet) return <FlatList {...props} />;
  return (
    <GestureDetector gesture={sheet.nativeScrollGesture}>
      <Animated.FlatList
        {...(props as object as React.ComponentProps<typeof Animated.FlatList<T>>)}
        scrollEventThrottle={16}
        onScroll={sheet.scrollHandler}
        animatedProps={sheet.scrollAnimatedProps}
      />
    </GestureDetector>
  );
}
