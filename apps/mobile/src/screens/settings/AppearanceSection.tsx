import { Pressable, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  ACCENTS,
  ACCENT_LABEL_KEYS,
  ACCENT_NAMES,
  LANGUAGES,
  type AccentName,
  type ThemePref,
} from "@atlastodo/shared";
import { usePreferences } from "../../hooks/usePreferences";
import { deviceLanguage } from "../../i18n";
import { ListPicker, type PickerOption } from "../../ui/ListPicker";
import { Row, Section } from "../../ui/Section";
import { Segmented } from "../../ui/Segmented";
import { Palette } from "../../ui/icons";
import { labelOptions } from "./shared";

const THEME_OPTIONS: { value: ThemePref; labelKey: string }[] = [
  { value: "system", labelKey: "settings.themeSystem" },
  { value: "light", labelKey: "settings.themeLight" },
  { value: "dark", labelKey: "settings.themeDark" },
];

/** Theme, accent colour and language. */
export function AppearanceSection() {
  const { t } = useTranslation();
  const { theme, setTheme, accent, setAccent, language, setLanguage } = usePreferences();

  const deviceLangCode = deviceLanguage();
  const deviceLangLabel = LANGUAGES.find((l) => l.code === deviceLangCode)?.label ?? deviceLangCode;
  const languageOptions: PickerOption<string>[] = [
    { value: "", label: t("settings.deviceDefault"), hint: deviceLangLabel },
    ...LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
  ];

  return (
    <Section icon={Palette} title={t("settings.appearance")}>
      <Row label={t("settings.theme")} description={t("settings.themeDesc")}>
        <Segmented
          value={theme}
          options={labelOptions(t, THEME_OPTIONS)}
          onChange={setTheme}
          label={t("settings.theme")}
        />
      </Row>
      <Row label={t("settings.accent")} description={t("settings.accentDesc")}>
        <View accessibilityRole="radiogroup" className="flex-row items-center gap-2">
          {ACCENT_NAMES.map((name) => (
            <Pressable
              key={name}
              accessibilityRole="radio"
              accessibilityState={{ selected: accent === name }}
              accessibilityLabel={t(ACCENT_LABEL_KEYS[name])}
              onPress={() => setAccent(name as AccentName)}
              style={{ backgroundColor: ACCENTS[name][600] }}
              className={
                "h-8 w-8 rounded-full border-2 " +
                (accent === name ? "border-neutral-900 dark:border-white" : "border-transparent")
              }
            />
          ))}
        </View>
      </Row>
      <ListPicker
        label={t("settings.language")}
        description={t("settings.languageDesc")}
        value={language}
        options={languageOptions}
        onChange={setLanguage}
      />
    </Section>
  );
}
