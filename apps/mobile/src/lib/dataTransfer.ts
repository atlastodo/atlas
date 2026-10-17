import * as DocumentPicker from "expo-document-picker";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";

/**
 * Platform file I/O for the Settings backup/restore feature. The serialization is the pure, shared
 * `@atlastodo/shared` `exportData`/`importBundle`; only this glue differs by platform. Native writes the
 * bundle to a cache file and hands it to the OS share sheet, and reads an imported file the user picks.
 * The RN-web build resolves `dataTransfer.web.ts` (a browser download + a file input) instead.
 */

/** Write the bundle to a cache file and open the OS share sheet so the user can save/send it. */
export async function saveBundle(text: string, filename: string): Promise<void> {
  const file = new File(Paths.cache, filename);
  if (file.exists) file.delete();
  file.create();
  file.write(text);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, {
      mimeType: "application/json",
      dialogTitle: filename,
      UTI: "public.json",
    });
  }
}

/** Let the user pick a JSON file and return its text, or null if they cancelled. */
export async function pickBundleText(): Promise<string | null> {
  return pickText("application/json");
}

/**
 * Let the user pick a CSV file (a TickTick export) and return its text, or null if they cancelled.
 * Some file providers hand a `.csv` back as `text/plain` or with no type at all, so the picker
 * accepts both rather than filtering the file out of the dialog.
 */
export async function pickCsvText(): Promise<string | null> {
  return pickText(["text/csv", "text/comma-separated-values", "text/plain"]);
}

/**
 * Let the user pick a Todoist export, a project's CSV or the backup zip, and return its name and
 * bytes, or null if they cancelled. Bytes, because the zip is binary; the importer decodes a CSV.
 */
export async function pickTodoistFile(): Promise<{ name: string; bytes: Uint8Array } | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: [
      "text/csv",
      "text/comma-separated-values",
      "text/plain",
      "application/zip",
      "application/x-zip-compressed",
    ],
    copyToCacheDirectory: true,
  });
  if (res.canceled) return null;
  const asset = res.assets?.[0];
  if (!asset) return null;
  return { name: asset.name, bytes: await new File(asset.uri).bytes() };
}

async function pickText(type: string | string[]): Promise<string | null> {
  const res = await DocumentPicker.getDocumentAsync({ type, copyToCacheDirectory: true });
  if (res.canceled) return null;
  const asset = res.assets?.[0];
  if (!asset) return null;
  return await new File(asset.uri).text();
}
