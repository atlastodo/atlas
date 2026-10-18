import { useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { BugReportSummary } from "@atlastodo/client-core";
import { useAdminReports, type ReportFilter } from "../hooks/useAdminReports";
import { useFormat } from "../hooks/useFormat";
import { useToast } from "../data/ToastProvider";
import { Segmented } from "../ui/Segmented";
import { SkeletonRows } from "../ui/Skeleton";
import { EmptyState } from "../ui/EmptyState";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ADMIN_CARD, AdminBadge, AdminRow } from "../ui/AdminRow";
import { AdminReportDetail } from "../ui/AdminReportDetail";
import { CircleAlert, Trash2 } from "../ui/icons";

/** The admin panel's error-report section. REST off the `ApiClient`, not the sync store. */
export function AdminReportsScreen() {
  const { t } = useTranslation();
  const format = useFormat();
  const toast = useToast();
  const {
    reports,
    hasMore,
    filter,
    setFilter,
    loading,
    failed,
    refresh,
    setResolved,
    deleteReport,
    deleteAllReports,
  } = useAdminReports();
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmingClearAll, setConfirmingClearAll] = useState(false);

  const filters: { value: ReportFilter; label: string }[] = [
    { value: "open", label: t("admin.open") },
    { value: "all", label: t("admin.all") },
  ];

  return (
    <View className="flex-1">
      <View className="flex-row items-center justify-between px-4 py-3">
        <View className="flex-1 pr-2">
          <Segmented
            value={filter}
            options={filters}
            onChange={setFilter}
            label={t("admin.reports")}
          />
        </View>
        {reports.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("admin.clearAll")}
            onPress={() => setConfirmingClearAll(true)}
            className="flex-row items-center gap-1 rounded-md bg-red-50 px-2.5 py-2 active:bg-red-100 dark:bg-red-950/40 dark:active:bg-red-950/60"
          >
            <Trash2 size={13} className="text-red-600 dark:text-red-400" />
            <Text className="text-xs font-medium text-red-600 dark:text-red-400">
              {t("admin.clearAll")}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {loading ? (
        <View className="px-4">
          <SkeletonRows count={6} />
        </View>
      ) : failed ? (
        <EmptyState
          icon={CircleAlert}
          title={t("admin.loadFailed")}
          actions={[{ label: t("common.retry"), onPress: () => void refresh(), primary: true }]}
        />
      ) : reports.length === 0 ? (
        <EmptyState icon={CircleAlert} title={t("admin.noReports")} />
      ) : (
        <FlatList
          data={reports}
          keyExtractor={(r) => r.id}
          contentContainerClassName={"mx-4 mb-16 " + ADMIN_CARD}
          renderItem={({ item, index }) => (
            <ReportRow
              report={item}
              first={index === 0}
              when={format.dateTime(item.occurred_at_ms)}
              onPress={() => setOpenId(item.id)}
            />
          )}
        />
      )}

      {openId ? (
        <AdminReportDetail
          id={openId}
          onClose={() => setOpenId(null)}
          onSetResolved={(resolved: boolean) => void setResolved(openId, resolved)}
          onDelete={() => {
            void deleteReport(openId);
            setOpenId(null);
            toast.show(t("admin.reportDeleted"));
          }}
        />
      ) : null}

      <ConfirmDialog
        visible={confirmingClearAll}
        title={t("admin.clearAllTitle")}
        message={t(
          filter === "open"
            ? hasMore
              ? "admin.clearOpenConfirmMore"
              : "admin.clearOpenConfirm"
            : hasMore
              ? "admin.clearAllConfirmMore"
              : "admin.clearAllConfirm",
          { count: reports.length },
        )}
        confirmLabel={t("admin.clearAll")}
        danger
        onConfirm={async () => {
          setConfirmingClearAll(false);
          const deleted = await deleteAllReports();
          toast.show(
            deleted === null
              ? t("admin.actionFailed")
              : t("admin.reportsCleared", { count: deleted }),
          );
        }}
        onCancel={() => setConfirmingClearAll(false)}
      />
    </View>
  );
}

function ReportRow({
  report,
  when,
  first,
  onPress,
}: {
  report: BugReportSummary;
  when: string;
  first: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AdminRow
      title={report.message}
      badges={
        report.resolved_at_ms != null ? (
          <AdminBadge label={t("admin.resolved")} tone="green" />
        ) : null
      }
      detail={`${report.platform} ${report.app_version} - ${when} - ${
        report.user_email ?? t("admin.anonymous")
      }`}
      first={first}
      onPress={onPress}
    />
  );
}
