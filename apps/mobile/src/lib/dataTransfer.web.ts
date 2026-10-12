/**
 * File I/O for Settings backup/restore on web: a browser download for export and a transient
 * `<input type=file>` for import. Native resolves `dataTransfer.ts` (expo-file-system + share
 * sheet); the serialization is the shared `@atlas/shared` helpers.
 */

/** Trigger a browser download of the bundle text. */
export async function saveBundle(text: string, filename: string): Promise<void> {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Open a file picker and resolve the chosen file's text, or null if the user cancelled. */
export function pickBundleText(): Promise<string | null> {
  return pickText("application/json,.json");
}

/** Same, for a TickTick CSV export. */
export function pickCsvText(): Promise<string | null> {
  return pickText("text/csv,.csv");
}

/** Same, for a Todoist export: a project's CSV or the backup zip, read as bytes. */
export function pickTodoistFile(): Promise<{ name: string; bytes: Uint8Array } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "text/csv,.csv,application/zip,.zip";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      void file
        .arrayBuffer()
        .then((buffer) => resolve({ name: file.name, bytes: new Uint8Array(buffer) }));
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

function pickText(accept: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      void file.text().then(resolve);
    };
    // Some browsers fire `cancel` when the dialog is dismissed; resolve null so the caller unblocks.
    input.oncancel = () => resolve(null);
    input.click();
  });
}
