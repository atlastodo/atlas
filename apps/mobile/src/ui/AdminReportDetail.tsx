import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { BugReportView } from "@atlastodo/client-core";
import { useAuth } from "../auth/AuthContext";
import { useFormat } from "../hooks/useFormat";
import { copyText } from "../lib/clipboard";
import { BottomSheet } from "./BottomSheet";
import { SheetScrollView } from "./SheetScroll";
import { ConfirmDialog } from "./ConfirmDialog";
import { DetailButton } from "./DetailButton";
import { Field } from "./Field";
import { SkeletonRows } from "./Skeleton";

/** One report in full: the fields the list omits (stack, diagnostics, breadcrumbs) plus the resolve toggle, fetched on open so the list payload stays small. */
export function AdminReportDetail({
  id,
  onClose,
  onSetResolved,
  onDelete,
}: {
  id: string;
  onClose: () => void;
  onSetResolved: (resolved: boolean) => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const { api } = useAuth();
  const format = useFormat();
  const [report, setReport] = useState<BugReportView | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setFailed(false);
    void api
      .getReport(id)
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, id]);

  const resolved = report?.resolved_at_ms != null;
  // Stored JSON from any client version: tolerate missing or null diagnostics and breadcrumbs.
  const diagnostics = report?.diagnostics ?? {};
  const crumbs =
    report && Array.isArray(report.breadcrumbs)
      ? report.breadcrumbs.filter((c) => c != null && typeof c === "object")
      : [];

  return (
    <BottomSheet visible onClose={onClose}>
      <View className="gap-3">
        <Text className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
          {t("admin.reportDetail")}
        </Text>

        {failed ? (
          <Text className="py-4 text-sm text-neutral-500">{t("admin.loadFailed")}</Text>
        ) : !report ? (
          <SkeletonRows count={5} />
        ) : (
          <SheetScrollView className="max-h-96">
            <Text className="pb-2 text-sm text-neutral-900 dark:text-neutral-100">
              {report.message}
            </Text>
            {report.description ? (
              <Text className="pb-2 text-sm text-neutral-600 dark:text-neutral-300">
                {report.description}
              </Text>
            ) : null}

            <Field label={t("report.appVersion")} value={report.app_version} />
            <Field
              label={t("report.platform")}
              value={`${report.platform}${report.os_version ? ` ${report.os_version}` : ""}`}
            />
            <Field label={t("report.route")} value={report.route ?? "-"} />
            <Field
              label={t("admin.reportedBy")}
              value={report.user_email ?? t("admin.anonymous")}
            />
            <Field label={t("admin.occurredAt")} value={format.dateTime(report.occurred_at_ms)} />
            <Field label={t("sync.pending")} value={String(diagnostics.pending ?? 0)} />
            {/* Not `sync.quarantined`: that key is a pluralised sentence for the sync badge. */}
            <Field label={t("admin.quarantined")} value={String(diagnostics.quarantined ?? 0)} />

            {report.stack ? (
              <>
                <Text className="pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-neutral-500">
                  {t("admin.stack")}
                </Text>
                <Text className="text-xs text-neutral-500">{report.stack}</Text>
              </>
            ) : null}

            {crumbs.length > 0 ? (
              <>
                <Text className="pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-neutral-500">
                  {t("admin.breadcrumbs")}
                </Text>
                {crumbs.map((crumb, i) => (
                  <Text key={`${crumb.at}-${i}`} className="text-xs text-neutral-500">
                    {`${crumb.code}${crumb.ref ? ` ${crumb.ref}` : ""}`}
                  </Text>
                ))}
              </>
            ) : null}
          </SheetScrollView>
        )}

        <View className="flex-row gap-2">
          <DetailButton
            label={t("admin.copyReport")}
            onPress={() => void copyText(JSON.stringify(report, null, 2))}
            disabled={!report}
          />
          <DetailButton
            label={resolved ? t("admin.reopen") : t("admin.markResolved")}
            onPress={() => {
              onSetResolved(!resolved);
              onClose();
            }}
            disabled={!report}
            primary
          />
          {onDelete ? (
            <DetailButton
              label={t("admin.deleteReport")}
              onPress={() => setConfirmingDelete(true)}
              disabled={!report}
              danger
            />
          ) : null}
        </View>

        {confirmingDelete && onDelete ? (
          <ConfirmDialog
            visible={confirmingDelete}
            title={t("admin.deleteReportTitle")}
            message={t("admin.deleteReportConfirm")}
            confirmLabel={t("admin.deleteReport")}
            danger
            onConfirm={() => {
              setConfirmingDelete(false);
              onDelete();
            }}
            onCancel={() => setConfirmingDelete(false)}
          />
        ) : null}
      </View>
    </BottomSheet>
  );
}
