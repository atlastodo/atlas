import { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import { ThemeScope } from "../theme/ThemeProvider";
import { BottomSheet } from "./BottomSheet";
import { SheetFlatList } from "./SheetScroll";
import { ELEVATED_SURFACE_CLASS, SCRIM_CLASS } from "./useSheetDismiss";
import { Check, ChevronDown, ChevronUp, Search, X } from "./icons";

/**
 * A single-choice picker: an anchored dropdown on web (with a search box above a threshold, so it
 * does not swallow the viewport), a slide-up sheet with pull-to-dismiss on native. The "chip"
 * variant is a centred pill for a screen's own content (not a settings row) and opens a centred
 * dialog on web instead of the dropdown.
 */

export interface PickerOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

const SEARCH_THRESHOLD = 12;

export function ListPicker<T extends string>({
  label,
  description,
  value,
  options,
  onChange,
  className,
  variant = "row",
}: {
  label: string;
  description?: string;
  value: T;
  options: PickerOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  variant?: "row" | "chip";
}) {
  const chip = variant === "chip";
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const isWeb = Platform.OS === "web";
  const { width: winWidth, height: winHeight } = useWindowDimensions();

  const triggerRef = useRef<View>(null);
  const menuRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  const selected = options.find((o) => o.value === value);
  const searchable = options.length > SEARCH_THRESHOLD;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const toggleOpen = () => {
    if (open) {
      close();
      return;
    }
    if (isWeb) {
      if (typeof window !== "undefined") {
        const el = triggerRef.current as unknown as HTMLElement | null;
        if (el && typeof el.getBoundingClientRect === "function") {
          const rect = el.getBoundingClientRect();
          setAnchor({
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
          });
        }
      }
      setOpen(true);
      return;
    }
    setOpen(true);
  };

  // Web: Escape, resize, or a scroll outside the menu dismisses it.
  useEffect(() => {
    if (
      !open ||
      !isWeb ||
      typeof window === "undefined" ||
      typeof window.addEventListener !== "function"
    )
      return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onResize = () => {
      close();
    };
    const onScroll = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target && menuRef.current) {
        const menuEl = menuRef.current as unknown as HTMLElement | null;
        if (
          menuEl &&
          (menuEl === target || (typeof menuEl.contains === "function" && menuEl.contains(target)))
        ) {
          return;
        }
      }
      close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, isWeb]);

  const dropdownPos = useMemo(() => {
    const viewportWidth = isWeb && typeof window !== "undefined" ? window.innerWidth : winWidth;
    const viewportHeight = isWeb && typeof window !== "undefined" ? window.innerHeight : winHeight;

    if (!anchor) {
      return {
        left: Math.max(8, (viewportWidth - 260) / 2),
        top: 80,
        bottom: undefined,
        width: Math.min(260, viewportWidth - 16),
        maxHeight: 320,
      };
    }
    const menuWidth = Math.min(Math.max(anchor.width, 240), Math.max(160, viewportWidth - 16));
    let left = anchor.x + anchor.width - menuWidth;
    if (left < 8) left = Math.max(8, anchor.x);
    if (left + menuWidth > viewportWidth - 8) left = Math.max(8, viewportWidth - menuWidth - 8);

    const itemHeight = 38;
    const searchHeight = searchable ? 40 : 0;
    const estimatedHeight = Math.min(320, searchHeight + options.length * itemHeight + 8);

    const spaceBelow = viewportHeight - (anchor.y + anchor.height + 4);
    const spaceAbove = anchor.y - 4;

    const fitsBelow = spaceBelow >= estimatedHeight;
    const fitsAbove = spaceAbove >= estimatedHeight;
    const openBelow = fitsBelow || (!fitsAbove && spaceBelow >= spaceAbove);

    if (openBelow) {
      const maxHeight = Math.min(320, Math.max(120, spaceBelow - 8));
      return {
        left,
        top: anchor.y + anchor.height + 4,
        bottom: undefined,
        width: menuWidth,
        maxHeight,
      };
    } else {
      const maxHeight = Math.min(320, Math.max(120, spaceAbove - 8));
      return {
        left,
        top: undefined,
        bottom: viewportHeight - anchor.y + 4,
        width: menuWidth,
        maxHeight,
      };
    }
  }, [anchor, isWeb, winWidth, winHeight, searchable, options.length]);

  const accessibilityValue = {
    text: selected?.hint ? `${selected.label}, ${selected.hint}` : (selected?.label ?? ""),
  };

  return (
    <>
      {chip ? (
        <View className={"items-center " + (className ?? "")}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityValue={accessibilityValue}
            onPress={toggleOpen}
            className="max-w-full flex-row items-center gap-2 rounded-full border border-neutral-200 px-4 py-2 web:cursor-pointer web:hover:bg-neutral-100 dark:border-neutral-800 dark:web:hover:bg-neutral-900"
          >
            <Text className="text-sm text-neutral-500">{label}</Text>
            <Text
              numberOfLines={1}
              className="shrink text-sm font-medium text-neutral-900 dark:text-neutral-100"
            >
              {selected?.label ?? ""}
            </Text>
            <ChevronDown size={14} className="text-neutral-500" />
          </Pressable>
        </View>
      ) : (
        <View
          className={
            "flex-row items-center justify-between gap-4 " +
            (className !== undefined
              ? className
              : "border-t border-neutral-100 py-3.5 dark:border-neutral-900")
          }
        >
          <View className="flex-1 gap-0.5">
            <Text
              className={
                "font-medium text-neutral-900 dark:text-neutral-100 " +
                (isWeb ? "text-sm" : "text-lg")
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
          <View ref={triggerRef} collapsable={false}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityValue={accessibilityValue}
              onPress={toggleOpen}
              className="max-w-[220px] shrink-0 flex-row items-center justify-between gap-2 rounded-xl border border-neutral-200 bg-neutral-50/50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-800/40"
            >
              <View className="shrink">
                <Text
                  numberOfLines={1}
                  className={
                    "text-neutral-900 dark:text-neutral-100 " + (isWeb ? "text-sm" : "text-base")
                  }
                >
                  {selected?.label ?? ""}
                </Text>
                {selected?.hint != null && (
                  // Two lines: in a 220px trigger a one-line hint is cut mid-word ("not counted agai…").
                  <Text
                    numberOfLines={2}
                    className={"text-neutral-500 " + (isWeb ? "text-xs" : "text-sm")}
                  >
                    {selected.hint}
                  </Text>
                )}
              </View>
              {open ? (
                <ChevronUp size={14} className="text-neutral-500" />
              ) : (
                <ChevronDown size={14} className="text-neutral-500" />
              )}
            </Pressable>
          </View>
        </View>
      )}

      {isWeb && chip ? (
        <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
          <ThemeScope className="absolute inset-0 items-center justify-center p-6">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("common.close")}
              onPress={close}
              className={`absolute inset-0 ${SCRIM_CLASS}`}
            />
            <View
              ref={menuRef}
              collapsable={false}
              style={{ maxHeight: Math.min(560, winHeight - 48) }}
              className={`w-full max-w-md overflow-hidden rounded-2xl ${ELEVATED_SURFACE_CLASS}`}
            >
              <View className="flex-row items-center gap-3 px-5 pb-2 pt-4">
                <Text className="flex-1 text-base font-semibold text-neutral-900 dark:text-neutral-100">
                  {label}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("common.close")}
                  onPress={close}
                  className="rounded-lg p-1 web:cursor-pointer web:hover:bg-neutral-100 dark:web:hover:bg-neutral-800"
                >
                  <X size={18} className="text-neutral-500" />
                </Pressable>
              </View>
              {searchable && (
                <View className="mx-5 mb-2 flex-row items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-1.5 dark:border-neutral-800 dark:bg-neutral-800/40">
                  <Search size={16} className="text-neutral-500" />
                  <TextInput
                    accessibilityLabel={t("common.search")}
                    placeholder={t("common.search")}
                    placeholderTextColor="#737373"
                    value={query}
                    onChangeText={setQuery}
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect={false}
                    className="flex-1 py-1 text-sm text-neutral-900 dark:text-neutral-100"
                  />
                  {query.length > 0 && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("common.clear")}
                      onPress={() => setQuery("")}
                      className="rounded p-0.5"
                    >
                      <X size={14} className="text-neutral-500" />
                    </Pressable>
                  )}
                </View>
              )}
              <ScrollView keyboardShouldPersistTaps="handled" className="px-2 pb-2">
                {shown.length === 0 ? (
                  <Text className="p-4 text-center text-sm text-neutral-500">
                    {t("common.nothingHere")}
                  </Text>
                ) : (
                  shown.map((item) => {
                    const active = item.value === value;
                    return (
                      <Pressable
                        key={item.value}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: active }}
                        accessibilityLabel={item.label}
                        onPress={() => {
                          onChange(item.value);
                          close();
                        }}
                        className={
                          "flex-row items-center gap-3 rounded-lg px-3 py-2.5 web:cursor-pointer " +
                          (active
                            ? "bg-accent-50 dark:bg-accent-950/70"
                            : "hover:bg-neutral-100/80 dark:hover:bg-neutral-800/60")
                        }
                      >
                        <View className="flex-1 gap-0.5">
                          <Text
                            className={
                              "text-sm " +
                              (active
                                ? "font-semibold text-accent-700 dark:text-accent-300"
                                : "text-neutral-800 dark:text-neutral-200")
                            }
                          >
                            {item.label}
                          </Text>
                          {item.hint != null && (
                            <Text className="text-xs text-neutral-500">{item.hint}</Text>
                          )}
                        </View>
                        {active && (
                          <Check
                            size={16}
                            className="shrink-0 text-accent-600 dark:text-accent-400"
                          />
                        )}
                      </Pressable>
                    );
                  })
                )}
              </ScrollView>
            </View>
          </ThemeScope>
        </Modal>
      ) : isWeb ? (
        <Modal visible={open} transparent animationType="none" onRequestClose={close}>
          <ThemeScope className="flex-1">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("common.close")}
              onPress={close}
              className="absolute inset-0"
            />
            <View
              ref={menuRef}
              collapsable={false}
              style={{
                position: "absolute",
                left: dropdownPos.left,
                ...(dropdownPos.top !== undefined ? { top: dropdownPos.top } : {}),
                ...(dropdownPos.bottom !== undefined ? { bottom: dropdownPos.bottom } : {}),
                width: dropdownPos.width,
                maxHeight: dropdownPos.maxHeight,
              }}
              className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-zinc-900"
            >
              {searchable && (
                <View className="flex-row items-center gap-2 border-b border-neutral-100 px-3 py-2 dark:border-neutral-800">
                  <Search size={14} className="text-neutral-500" />
                  <TextInput
                    accessibilityLabel={t("common.search")}
                    placeholder={t("common.search")}
                    placeholderTextColor="#737373"
                    value={query}
                    onChangeText={setQuery}
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect={false}
                    className="flex-1 py-1 text-xs text-neutral-900 dark:text-neutral-100"
                  />
                  {query.length > 0 && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("common.clear")}
                      onPress={() => setQuery("")}
                      className="rounded p-0.5"
                    >
                      <X size={12} className="text-neutral-500" />
                    </Pressable>
                  )}
                </View>
              )}

              <ScrollView
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={true}
                style={{ maxHeight: dropdownPos.maxHeight - (searchable ? 40 : 0) }}
                className="py-1"
              >
                {shown.length === 0 ? (
                  <Text className="p-3 text-center text-xs text-neutral-500">
                    {t("common.nothingHere")}
                  </Text>
                ) : (
                  shown.map((item) => {
                    const active = item.value === value;
                    return (
                      <Pressable
                        key={item.value}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: active }}
                        accessibilityLabel={item.label}
                        onPress={() => {
                          onChange(item.value);
                          close();
                        }}
                        className={
                          "flex-row items-center justify-between px-3 py-2 web:cursor-pointer " +
                          (active
                            ? "bg-accent-50 dark:bg-accent-950"
                            : "hover:bg-neutral-100/80 dark:hover:bg-neutral-800/60")
                        }
                      >
                        <View className="flex-1 gap-0.5 pr-2">
                          <Text
                            className={
                              "text-xs " +
                              (active
                                ? "font-semibold text-accent-700 dark:text-accent-300"
                                : "text-neutral-800 dark:text-neutral-200")
                            }
                          >
                            {item.label}
                          </Text>
                          {item.hint != null && (
                            <Text className="text-[11px] text-neutral-500 dark:text-neutral-400">
                              {item.hint}
                            </Text>
                          )}
                        </View>
                        {active && (
                          <Check
                            size={14}
                            className="shrink-0 text-accent-600 dark:text-accent-400"
                          />
                        )}
                      </Pressable>
                    );
                  })
                )}
              </ScrollView>
            </View>
          </ThemeScope>
        </Modal>
      ) : (
        <BottomSheet visible={open} onClose={close}>
          <View className="max-h-[75vh] flex-col">
            <View className="flex-row items-center gap-3 border-b border-neutral-100 pb-3 pt-1 dark:border-neutral-900">
              <Text className="flex-1 text-lg font-bold text-neutral-900 dark:text-neutral-100">
                {label}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("common.close")}
                onPress={close}
                className="rounded-lg p-1"
              >
                <X size={20} className="text-neutral-500" />
              </Pressable>
            </View>

            {searchable && (
              <View className="my-2 flex-row items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-1.5 dark:border-neutral-800 dark:bg-neutral-800/40">
                <Search size={16} className="text-neutral-500" />
                <TextInput
                  accessibilityLabel={t("common.search")}
                  placeholder={t("common.search")}
                  placeholderTextColor="#737373"
                  value={query}
                  onChangeText={setQuery}
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="flex-1 py-1 text-base text-neutral-900 dark:text-neutral-100"
                />
              </View>
            )}

            <SheetFlatList
              data={shown}
              keyExtractor={(o: PickerOption<T>) => o.value}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }: { item: PickerOption<T> }) => {
                const active = item.value === value;
                return (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={item.label}
                    onPress={() => {
                      onChange(item.value);
                      close();
                    }}
                    className="flex-row items-center gap-3 border-b border-neutral-100 py-3 dark:border-neutral-900"
                  >
                    <View className="flex-1 gap-0.5">
                      <Text className="text-base text-neutral-900 dark:text-neutral-100">
                        {item.label}
                      </Text>
                      {item.hint != null && (
                        <Text className="text-sm text-neutral-500">{item.hint}</Text>
                      )}
                    </View>
                    {active && <Check size={16} className="text-accent-600" />}
                  </Pressable>
                );
              }}
              ListEmptyComponent={
                <Text className="p-4 text-sm text-neutral-500">{t("common.nothingHere")}</Text>
              }
            />
          </View>
        </BottomSheet>
      )}
    </>
  );
}
