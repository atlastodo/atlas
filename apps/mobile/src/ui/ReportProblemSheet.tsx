import { useMemo, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import { buildPreview, mintReportId, sendReport } from "../lib/crashReporter";
import { copyText } from "../lib/clipboard";
import { useCancelOnEscape } from "../hooks/useCancelOnEscape";
import { BottomSheet } from "./BottomSheet";
import { SheetScrollView } from "./SheetScroll";
import { PLACEHOLDER_COLOR } from "./useSheetDismiss";
import { Field } from "./Field";
import { Check } from "./icons";

/**
 * "Report a problem": send a diagnostics report with a description, for bugs that do not crash the
 * app. The panel shows the actual payload as it will be sent, field by field, with a button to copy
 * the JSON, so the user can read every byte before sending.
 */
export function ReportProblemSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [description, setDescription] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [showPayload, setShowPayload] = useState(false);
  const esc = useCancelOnEscape(() => {
    setDescription("");
    onClose();
  });

  // One id and time per opening, so the send stays idempotent while the preview is rebuilt.
  const stamp = useMemo(() => (open ? { id: mintReportId(), now: Date.now() } : null), [open]);
  // The preview is the report: rebuilt as the description changes, and sent exactly as shown.
  const preview = useMemo(
    () =>
      stamp
        ? buildPreview(
            "manual",
            new Error("manual report"),
            stamp.now,
            description.trim() || undefined,
            stamp.id,
          )
        : null,
    [stamp, description],
  );

  const send = async () => {
    const text = description.trim();
    if (!text || sending || !preview) return;
    setSending(true);
    const outcome = await sendReport(preview);
    setSending(false);
    setResult(
      outcome === "sent"
        ? t("report.sent")
        : outcome === "queued"
          ? t("report.queued")
          : t("report.failed"),
    );
    if (outcome !== "failed") {
      setDescription("");
      onClose();
    }
  };

  return (
    <BottomSheet
      visible={open}
      onClose={onClose}
      title={t("report.title")}
      headerAction={
        Platform.OS !== "web" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.done", "Done")}
            onPress={() => Keyboard.dismiss()}
            hitSlop={8}
            className="flex-row items-center gap-1 rounded-md bg-neutral-100 px-2.5 py-1 active:bg-neutral-200 dark:bg-neutral-800 dark:active:bg-neutral-700"
          >
            <Check size={14} className="text-neutral-700 dark:text-neutral-200" />
            <Text className="text-xs font-medium text-neutral-700 dark:text-neutral-200">
              {t("common.done", "Done")}
            </Text>
          </Pressable>
        ) : undefined
      }
    >
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Pressable onPress={() => Keyboard.dismiss()}>
          <View className="gap-3">
            <TextInput
              ref={esc.ref}
              onKeyPress={esc.onKeyPress}
              value={description}
              onChangeText={setDescription}
              multiline
              numberOfLines={4}
              accessibilityLabel={t("report.whatHappened")}
              placeholder={t("report.placeholder")}
              placeholderTextColor={PLACEHOLDER_COLOR}
              className="min-h-24 rounded-lg border border-neutral-200 p-3 text-sm text-neutral-900 dark:border-neutral-800 dark:text-neutral-100"
              textAlignVertical="top"
            />

            <SheetScrollView
              className="max-h-64"
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
            >
              <Text className="pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
                {t("report.whatIsSent")}
              </Text>
              <Text className="pb-2 text-xs text-neutral-500">{t("report.noTaskContent")}</Text>
              {preview ? (
                <>
                  <Field label={t("report.appVersion")} value={preview.appVersion} />
                  <Field
                    label={t("report.platform")}
                    value={`${preview.platform}${preview.osVersion ? ` ${preview.osVersion}` : ""}`}
                  />
                  <Field label={t("report.route")} value={preview.route ?? "-"} />
                  <Field
                    label={t("sync.status")}
                    value={preview.diagnostics.syncStatus ?? t("sync.never")}
                  />
                  <Field label={t("sync.pending")} value={String(preview.diagnostics.pending)} />
                  <Field
                    label={t("report.breadcrumbs")}
                    value={String(preview.breadcrumbs.length)}
                  />
                  {showPayload ? (
                    <Text className="mt-2 text-xs text-neutral-500">
                      {JSON.stringify(preview, null, 2)}
                    </Text>
                  ) : null}
                </>
              ) : null}
            </SheetScrollView>

            {preview ? (
              <View className="flex-row gap-2">
                <SheetButton
                  label={showPayload ? t("report.hidePayload") : t("report.showPayload")}
                  onPress={() => setShowPayload((v) => !v)}
                />
                <SheetButton
                  label={t("report.copyPayload")}
                  onPress={() => void copyText(JSON.stringify(preview, null, 2))}
                />
              </View>
            ) : null}

            {result ? <Text className="text-xs text-neutral-500">{result}</Text> : null}

            <View className="flex-row gap-2">
              <SheetButton label={t("common.cancel")} onPress={onClose} />
              <SheetButton
                label={sending ? t("report.sending") : t("report.send")}
                onPress={() => void send()}
                disabled={sending || description.trim().length === 0}
                primary
              />
            </View>
          </View>
        </Pressable>
      </KeyboardAvoidingView>
    </BottomSheet>
  );
}

function SheetButton({
  label,
  onPress,
  primary,
  disabled,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`flex-1 items-center rounded-lg border px-3 py-3 ${
        primary ? "border-accent-600 bg-accent-600" : "border-neutral-200 dark:border-neutral-800"
      } ${disabled ? "opacity-50" : ""}`}
    >
      <Text
        className={`text-sm font-medium ${
          primary ? "text-white" : "text-neutral-700 dark:text-neutral-200"
        }`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
