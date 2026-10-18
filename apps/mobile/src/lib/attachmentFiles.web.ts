import type { DocumentPickerAsset } from "expo-document-picker";
import { blobSource, bytesSource, type AttachmentSource } from "@atlastodo/client-core";

/** Web file I/O for task attachments: a browser download stands in for the share sheet. Native resolves `attachmentFiles.ts`. */

/** A picked file open for reading in ranges. `close` when done with it. */
export interface PickedFile {
  source: AttachmentSource;
  close(): void;
}

/** Open a picked document for reading; the `File` on the asset is read slice by slice. */
export async function openPickedFile(asset: DocumentPickerAsset): Promise<PickedFile> {
  if (asset.file) return { source: blobSource(asset.file), close: () => {} };
  // Without a `File` the picker returned base64 (`copyToCacheDirectory` is a no-op on web).
  const bin = atob(asset.base64 ?? "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { source: bytesSource(bytes), close: () => {} };
}

/** How long a download's object URL outlives the click that started it. */
const REVOKE_AFTER_MS = 60_000;

/** Nothing to discard: the web picker hands over an in-memory `File`, never a cache copy. */
export function discardPickedFile(_asset: DocumentPickerAsset): void {}

/** Nothing to clear: a browser download leaves no copy the app can reach. */
export function clearSharedFiles(): void {}

/** Trigger a browser download of the decrypted file. */
export async function shareFile(bytes: Uint8Array, filename: string, mime: string): Promise<void> {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Some browsers read the URL only after the click handler returns; revoking at once can fail the download.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}
