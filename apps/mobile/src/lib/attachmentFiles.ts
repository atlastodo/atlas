import * as Sharing from "expo-sharing";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import type { DocumentPickerAsset } from "expo-document-picker";
import type { AttachmentSource } from "@atlastodo/client-core";

/**
 * Native file I/O for task attachments (web resolves `attachmentFiles.web.ts`). The pipeline itself
 * is in `@atlastodo/client-core`; only this glue touches the disk and the OS share sheet.
 *
 * A picked file is read in ranges while it is encrypted, so it is never whole in memory; a
 * decrypted file is written straight to a cache file for open-in.
 *
 * Plaintext does not linger: the picker's cache copy is deleted once read, and shared files live
 * under one scratch directory emptied before the next share and at app start (not when the share
 * sheet closes, since the receiving app may still be reading).
 */

/** Longest filename kept, in UTF-16 units (well under every platform's 255-byte name limit). */
const MAX_NAME = 100;

/**
 * Reduce an untrusted display name to one safe path segment: the last component after either
 * separator, without control characters, characters Android/Windows reject, or leading dots (so
 * never `.`, `..` or a hidden file), shortened with its extension kept.
 */
export function safeFilename(name: string): string {
  let base = name.split(/[/\\]/).pop() ?? "";
  base = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[:*?"<>|]/g, "_")
    .trim()
    .replace(/^\.+/, "");
  if (base.length > MAX_NAME) {
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 && base.length - dot <= 16 ? base.slice(dot) : "";
    base = base.slice(0, MAX_NAME - ext.length) + ext;
  }
  return base || "attachment";
}

/** The scratch directory (under the OS cache) holding decrypted files handed to the share sheet. */
const SHARE_DIR = "attachment-share";

function shareRoot(): Directory {
  return new Directory(Paths.cache, SHARE_DIR);
}

/** Whether `uri` names something strictly inside `dir` (after the platform normalised it). */
function isInside(uri: string, dir: Directory): boolean {
  const prefix = dir.uri.endsWith("/") ? dir.uri : `${dir.uri}/`;
  return uri.startsWith(prefix) && uri.length > prefix.length;
}

/** Delete every decrypted file a previous share left behind. Safe to call at any time. */
export function clearSharedFiles(): void {
  try {
    const root = shareRoot();
    if (root.exists) root.delete();
  } catch {
    // Best effort: a stale scratch file is retried on the next share or launch.
  }
}

/** Delete the picker's plaintext cache copy of a file that will not be attached after all. */
export function discardPickedFile(asset: DocumentPickerAsset): void {
  try {
    const file = new File(asset.uri);
    if (isInside(file.uri, Paths.cache) && file.exists) file.delete();
  } catch {
    // Best effort; the OS reclaims cache space eventually.
  }
}

/** A picked file open for reading in ranges. `close` when done with it. */
export interface PickedFile {
  source: AttachmentSource;
  close(): void;
}

/**
 * Open a picked document (already copied into the app's cache) for reading in ranges. Closing it
 * deletes that plaintext copy, since the queue keeps only ciphertext.
 */
export async function openPickedFile(asset: DocumentPickerAsset): Promise<PickedFile> {
  let handle: ReturnType<File["open"]>;
  let size: number;
  try {
    const file = new File(asset.uri);
    handle = file.open(FileMode.ReadOnly);
    size = handle.size ?? file.size;
  } catch (err) {
    discardPickedFile(asset);
    throw err;
  }
  return {
    source: {
      size,
      read: async (offset, length) => {
        handle.offset = offset;
        return handle.readBytes(length);
      },
    },
    close: () => {
      try {
        handle.close();
      } catch {
        // Already closed.
      }
      discardPickedFile(asset);
    },
  };
}

/**
 * Write the decrypted file into a fresh random directory under the share scratch directory and
 * hand it to the OS share sheet.
 *
 * The filename comes from decrypted metadata any project member can write, so it is untrusted: only
 * a sanitised basename is used, and the resolved path is checked to stay inside the scratch
 * directory. Otherwise a name like `../files/SQLite/<db>` would overwrite the app's own files.
 */
export async function shareFile(bytes: Uint8Array, filename: string, mime: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) return;
  clearSharedFiles();
  const root = shareRoot();
  const dir = new Directory(root, globalThis.crypto.randomUUID());
  const name = safeFilename(filename);
  const file = new File(dir, name);
  if (!isInside(root.uri, Paths.cache) || !isInside(dir.uri, root) || !isInside(file.uri, dir)) {
    throw new Error("refusing to write an attachment outside the share directory");
  }
  dir.create({ intermediates: true, idempotent: true });
  file.create();
  file.write(bytes);
  await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle: name });
}
