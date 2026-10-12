import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Image, Modal, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  ApiError,
  AttachmentTooLargeError,
  bytesToBase64,
  decryptMeta,
  maxAttachmentBytes,
  unwrapAekAny,
  type AttachmentUploadState,
  type Task,
} from "@atlas/client-core";
import * as DocumentPicker from "expo-document-picker";
import type { DocumentPickerAsset } from "expo-document-picker";
import { useAuth } from "../auth/AuthContext";
import { useAttachments, canUseAttachments, type AttachmentView } from "../hooks/useAttachments";
import { discardPickedFile, openPickedFile, shareFile } from "../lib/attachmentFiles";
import { useStore } from "../data/StoreProvider";
import { useToast } from "../data/ToastProvider";
import {
  CircleAlert,
  Download,
  FileText,
  LoaderCircle,
  Paperclip,
  Plus,
  RotateCcw,
  Trash2,
  type LucideIcon,
} from "./icons";

/**
 * Task attachments: a header, an add button and a row per file.
 *
 * Row states:
 * - idle: metadata only; the file is fetched on tap, one at a time, so opening a task does not
 *   download every attachment.
 * - downloading: blob GET + decrypt in flight. Images then open in the lightbox, anything else in
 *   the OS share sheet; the bytes are not kept.
 * - pending: the last tap failed (metadata can outrun the blob while another device's upload
 *   drains). After {@link MAX_LAZY_RETRIES} failures it reads as unavailable; a 429 or 503 is not
 *   counted.
 * - uploading: a device-local queue row still in its backoff (only rows whose metadata is not yet
 *   released).
 * - failed / cancelled: terminal queue states. They offer retry and delete; deleting a queue-only
 *   row drops it from the device-local queue.
 *
 * A server that reports attachments disabled gets no section. Rows are generic icons (no
 * thumbnails); the lightbox fetches the full blob.
 */

/** Failed fetches before a metadata-backed row reads as "unavailable". */
const MAX_LAZY_RETRIES = 3;

/** One blob's download state, keyed by blob sha; absent means idle. */
interface FetchState {
  status: "downloading" | "failed";
  retries: number;
}

/** A device-local queue entry for this task that has no synced metadata row (yet, or ever). */
interface QueueRowInfo {
  id: string;
  state: Extract<AttachmentUploadState, "queued" | "failed" | "cancelled">;
  lastError: string | null;
  filename: string;
  mime: string;
  blobSize: number;
}

type RowState =
  "idle" | "pending" | "uploading" | "downloading" | "failed" | "cancelled" | "missing";

interface DisplayRow {
  id: string;
  filename: string;
  mime: string;
  size: number;
  state: RowState;
  detail: string | null;
  /** How delete removes this row: a synced entity (soft-delete) or a device-local queue entry. */
  deleteAs: "entity" | "queue";
  /** Whether the row has a failed upload the user can try again. */
  retryable: boolean;
}

/** "6.2 MB"-style size label; locale-neutral. */
function formatSize(bytes: number): string {
  if (bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(mime: string): boolean {
  return mime.startsWith("image/");
}

/** Per-row icon: a generic file glyph. */
function stateIcon(state: RowState): LucideIcon {
  switch (state) {
    case "uploading":
    case "downloading":
      return LoaderCircle;
    case "failed":
    case "cancelled":
    case "missing":
      return CircleAlert;
    case "pending":
      return Download;
    default:
      return FileText;
  }
}

export function AttachmentsSection({ task }: { task: Task }) {
  const { t } = useTranslation();
  const { keyring } = useAuth();
  const { attachments: ctx, version, localOnly } = useStore();
  const { attachments, add, load, remove } = useAttachments(task);
  const toast = useToast();

  // E2EE only: without an unlocked keyring there is no queue and no picker, and no plaintext fallback.
  const enabled = canUseAttachments(keyring) && ctx != null;
  const server = ctx?.server ?? null;

  const [fetches, setFetches] = useState<Record<string, FetchState>>({});
  const [lightbox, setLightbox] = useState<{ name: string; uri: string } | null>(null);

  const [queueRows, setQueueRows] = useState<QueueRowInfo[]>([]);
  // Reads overlap; only the latest may land, or an older listing would bring back a removed row.
  const queueReads = useRef(0);
  const readQueueRows = useCallback(async () => {
    if (!ctx) return;
    const read = ++queueReads.current;
    const entries = await ctx.queue.entries();
    if (read !== queueReads.current) return;
    const preferred = task.project_id ? keyring?.getProjectKey(task.project_id) : null;
    setQueueRows(
      entries
        .filter((e) => e.taskId === task.id && e.state !== "uploading")
        .map((e) => {
          let filename = "";
          let mime = "";
          if (keyring?.hasKeys()) {
            try {
              const m = decryptMeta(unwrapAekAny(e.wrappedKey, keyring, e.id, preferred), e.meta);
              filename = m.filename;
              mime = m.mime;
            } catch {}
          }
          return {
            id: e.id,
            state: e.state as QueueRowInfo["state"],
            lastError: e.lastError,
            filename,
            mime,
            blobSize: e.blobSize,
          };
        }),
    );
  }, [ctx, task.id, task.project_id, keyring]);
  // Re-read on every store version bump and on foreground.
  useEffect(() => {
    void readQueueRows();
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void readQueueRows();
    });
    return () => sub.remove();
  }, [readQueueRows, version]);

  const queueById = new Map(queueRows.map((q) => [q.id, q]));

  const fetchesRef = useRef(fetches);
  fetchesRef.current = fetches;
  const downloads = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const openBytes = useCallback(
    (name: string, mime: string, bytes: Uint8Array) => {
      if (isImage(mime)) {
        setLightbox({ name, uri: `data:${mime};base64,${bytesToBase64(bytes)}` });
        return;
      }
      void shareFile(bytes, name, mime || "application/octet-stream").catch(() => {
        toast.show(t("attachment.openFailed"));
      });
    },
    [toast, t],
  );

  const download = useCallback(
    (row: AttachmentView) => {
      const sha = row.blobSha;
      if (fetchesRef.current[sha]?.status === "downloading") return;
      setFetches((f) => ({
        ...f,
        [sha]: { status: "downloading", retries: f[sha]?.retries ?? 0 },
      }));
      downloads.current = downloads.current.then(async () => {
        try {
          const bytes = await load(row.id);
          if (!mounted.current) return;
          setFetches(({ [sha]: _done, ...rest }) => rest);
          openBytes(row.filename || t("attachment.unnamed"), row.mime, bytes);
        } catch (err) {
          if (!mounted.current) return;
          // 404, 403 and integrity failures count towards "unavailable"; a 429 or 503 only asked us to wait.
          const limited = err instanceof ApiError && (err.status === 429 || err.status === 503);
          setFetches((f) => {
            if (limited) {
              const { [sha]: _limited, ...rest } = f;
              return rest;
            }
            return { ...f, [sha]: { status: "failed", retries: (f[sha]?.retries ?? 0) + 1 } };
          });
          if (limited) toast.show(t("attachment.openFailed"));
        }
      });
    },
    [load, openBytes, toast, t],
  );

  const rows: DisplayRow[] = [];
  for (const a of attachments) {
    const local = queueById.get(a.id);
    if (local?.state === "failed" || local?.state === "cancelled") {
      rows.push({
        id: a.id,
        filename: a.filename,
        mime: a.mime,
        size: a.blobSize,
        state: local.state,
        detail: local.lastError,
        deleteAs: "entity",
        retryable: true,
      });
      continue;
    }
    const st = fetches[a.blobSha];
    const unavailable = st?.status === "failed" && st.retries >= MAX_LAZY_RETRIES;
    rows.push({
      id: a.id,
      filename: a.filename,
      mime: a.mime,
      size: a.blobSize,
      state: unavailable
        ? "missing"
        : st?.status === "downloading"
          ? "downloading"
          : st?.status === "failed"
            ? "pending"
            : local?.state === "queued"
              ? "uploading"
              : "idle",
      detail: unavailable ? t("attachment.missing") : null,
      deleteAs: "entity",
      retryable: false,
    });
  }
  // Queue-only rows: terminal failures whose metadata was never released, plus unreleased uploads.
  for (const q of queueRows) {
    if (attachments.some((a) => a.id === q.id)) continue;
    rows.push({
      id: q.id,
      filename: q.filename,
      mime: q.mime,
      size: q.blobSize,
      state: q.state === "queued" ? "uploading" : q.state,
      detail: q.lastError,
      deleteAs: "queue",
      retryable: q.state !== "queued",
    });
  }

  const picking = useRef(false);
  const pick = async () => {
    if (picking.current) return;
    picking.current = true;
    try {
      const res = await DocumentPicker.getDocumentAsync({
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (res.canceled) return;
      const asset: DocumentPickerAsset | undefined = res.assets?.[0];
      if (!asset) return;
      // Refuse an oversized file before reading and encrypting it.
      const maxBytes = maxAttachmentBytes(server?.maxBlobBytes ?? undefined);
      if (typeof asset.size === "number" && asset.size > maxBytes) {
        discardPickedFile(asset);
        toast.show(t("attachment.tooLarge", { size: formatSize(maxBytes) }));
        return;
      }
      const picked = await openPickedFile(asset);
      try {
        await add({
          filename: asset.name || t("attachment.unnamed"),
          mime: asset.mimeType || "application/octet-stream",
          source: picked.source,
        });
      } finally {
        picked.close();
      }
      // A first attempt that failed for good changes nothing in the store, so re-read the queue.
      void readQueueRows();
    } catch (err) {
      toast.show(
        err instanceof AttachmentTooLargeError
          ? t("attachment.tooLarge", { size: formatSize(err.maxBytes) })
          : t("attachment.addFailed"),
      );
    } finally {
      picking.current = false;
    }
  };

  const openRow = (row: DisplayRow) => {
    if (row.deleteAs === "queue" || row.retryable || row.state === "uploading") return;
    const view = attachments.find((a) => a.id === row.id);
    if (view) download(view);
  };

  const retryRow = (row: DisplayRow) => {
    if (!ctx) return;
    void ctx.queue
      .retry(row.id)
      .then(() => readQueueRows())
      .then(() => ctx.queue.drain())
      .then(() => readQueueRows())
      .catch(() => toast.show(t("attachment.addFailed")));
  };

  const deleteRow = (row: DisplayRow) => {
    if (row.deleteAs === "queue") {
      // No synced entity exists: drop the device-local row. The server's blob GC owns any orphaned bytes.
      void ctx?.removeUpload(row.id).then(() => readQueueRows());
      return;
    }
    // Without this a failed upload behind a synced row would come back as a queue-only row.
    if (row.retryable) void ctx?.removeUpload(row.id).then(() => readQueueRows());
    const undo = remove(row.id);
    toast.show(t("attachment.deleted"), { label: t("common.undo"), run: undo });
  };

  // Files are stored on the server; local-only mode has none.
  if (localOnly || server?.enabled === false) return null;

  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <Paperclip size={16} className="text-neutral-500" />
        <Text className="text-xs font-medium text-neutral-500">{t("attachment.heading")}</Text>
        <View className="flex-1" />
        {enabled && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("attachment.add")}
            onPress={() => void pick()}
            hitSlop={8}
          >
            <Plus size={16} className="text-accent-600" />
          </Pressable>
        )}
      </View>

      {enabled && (
        <View className="gap-1.5">
          {rows.map((row) => (
            <AttachmentRow
              key={row.id}
              row={row}
              onPress={() => openRow(row)}
              onRetry={() => retryRow(row)}
              onDelete={() => deleteRow(row)}
            />
          ))}
        </View>
      )}

      {lightbox && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setLightbox(null)}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.close")}
            className="flex-1 bg-black/90 p-2"
            onPress={() => setLightbox(null)}
          >
            <Image
              source={{ uri: lightbox.uri }}
              resizeMode="contain"
              className="flex-1"
              accessibilityLabel={t("attachment.open", { name: lightbox.name })}
            />
          </Pressable>
        </Modal>
      )}
    </View>
  );
}

/** One row: a generic icon, the decrypted filename, a size chip and a state badge, with the trash affordance for the owner. */
function AttachmentRow({
  row,
  onPress,
  onRetry,
  onDelete,
}: {
  row: DisplayRow;
  onPress: () => void;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const Icon = stateIcon(row.state);
  const name = row.filename || t("attachment.unnamed");
  const size = formatSize(row.size);
  const badge =
    row.state === "idle" || row.state === "missing" ? null : t(`attachment.${row.state}`);
  const openable = row.deleteAs === "entity" && !row.retryable && row.state !== "uploading";

  return (
    <View className="flex-row items-center gap-2.5 rounded-lg px-1 py-1.5">
      <Icon size={18} className="text-neutral-500" />
      <Pressable
        accessibilityRole={openable ? "button" : undefined}
        accessibilityLabel={t("attachment.open", { name })}
        onPress={onPress}
        className="min-w-0 flex-1 web:cursor-pointer"
      >
        <Text numberOfLines={1} className="text-sm text-neutral-800 dark:text-neutral-100">
          {name}
        </Text>
        <View className="flex-row items-center gap-1.5">
          {size !== "" && <Text className="text-xs tabular-nums text-neutral-500">{size}</Text>}
          {badge && <Text className="text-xs text-neutral-500">{badge}</Text>}
          {row.detail && (
            <Text numberOfLines={1} className="text-xs text-red-500">
              {row.detail}
            </Text>
          )}
        </View>
      </Pressable>
      {row.retryable && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("attachment.retry")}
          onPress={onRetry}
          hitSlop={8}
        >
          <RotateCcw size={14} className="text-neutral-500" />
        </Pressable>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("attachment.delete")}
        onPress={onDelete}
        hitSlop={8}
      >
        <Trash2 size={14} className="text-neutral-500" />
      </Pressable>
    </View>
  );
}
