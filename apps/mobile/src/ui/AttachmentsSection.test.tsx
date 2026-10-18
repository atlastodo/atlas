import { act, fireEvent, render as render, screen, waitFor } from "@testing-library/react-native";
import {
  ApiError,
  AttachmentQueue,
  encryptBlob,
  encryptMeta,
  generateAek,
  generateDek,
  keyForScope,
  Keyring,
  LocalStore,
  MemoryPersistence,
  NetworkError,
  sealedBlobSize,
  wrapAek,
  type ApiClient,
  type AttachmentCiphertext,
  type BlobTransport,
  type Task,
} from "@atlastodo/client-core";
import * as DocumentPicker from "expo-document-picker";
import { fakeAuth, withApp } from "../testutil";
import { AttachmentsSection } from "./AttachmentsSection";

/**
 * Screen behaviour over the real pipeline: a real `LocalStore`, a real `AttachmentQueue` (the
 * `withApp` attachments wiring -- the same shape `StoreProvider` builds), real crypto for seeded
 * metadata, and doubles only at the platform edges (the document picker, the file read, the blob
 * transport). The queue's retry/backoff mechanics are exhaustively tested in `client-core`;
 * these tests cover what the UI does with those states.
 */

// The picker and the file system are native modules (no jest double ships); the platform glue
// over them has its own test, so this one stands in for it whole. The `mock*` names keep
// babel-plugin-jest-hoist happy about the out-of-scope references inside the factories.
const mockPickBytes = { current: new Uint8Array([1, 2, 3]) };
const mockClosePicked = jest.fn();
const mockFiles = {
  open: jest.fn(async () => {
    const bytes = mockPickBytes.current;
    return {
      source: {
        size: bytes.length,
        read: async (offset: number, length: number) => bytes.slice(offset, offset + length),
      },
      close: mockClosePicked,
    };
  }),
  close: mockClosePicked,
  share: jest.fn(async (_bytes: Uint8Array, _name: string, _mime: string) => {}),
};
jest.mock("../lib/attachmentFiles", () => ({
  openPickedFile: () => mockFiles.open(),
  shareFile: (bytes: Uint8Array, name: string, mime: string) => mockFiles.share(bytes, name, mime),
  discardPickedFile: () => {},
  clearSharedFiles: () => {},
}));
jest.mock("expo-document-picker", () => ({
  getDocumentAsync: jest.fn(),
}));
const getDocumentAsync = DocumentPicker.getDocumentAsync as jest.Mock;

beforeEach(() => {
  mockFiles.open.mockClear();
  mockFiles.close.mockClear();
  mockFiles.share.mockClear();
});

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    project_id: null,
    section_id: null,
    parent_id: null,
    title: "Buy milk",
    notes: "",
    priority: 4,
    start_at: null,
    due_at: null,
    is_completed: false,
    completed_at: null,
    archived_at: null,
    deleted_at: null,
    recurrence: null,
    assignee_id: null,
    estimate_min: null,
    label_ids: [],
    sort_order: 0,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

const keyring = new Keyring({ dek: generateDek() });
const session = {
  accessToken: "a",
  refreshToken: "r",
  deviceId: "d",
  user: { id: "me", email: "me@example.com", display_name: "Me" },
};

/** The one auth keyring (the AEK unwrap target for seeded rows). */
const authKeyring = () => keyring;

/**
 * An auth value whose `api` speaks the blob bridge (`putBlob`/`streamBlob`) over the given
 * transport. The download path reads the session's ApiClient -- exactly what production does -- so
 * a test serves/withholds blobs through the same seam the real client uses.
 */
function e2eeAuth(transport?: BlobTransport) {
  const get =
    transport?.get ??
    (async () => {
      throw new ApiError(404, "not found");
    });
  return fakeAuth({
    session,
    keyring,
    api: {
      putBlob: transport?.put ?? (async () => "stored" as const),
      streamBlob: get,
    } as unknown as ApiClient,
  });
}

const plainSha = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Write a real attachment entity the way the sync layer delivers one: all eight plaintext fields,
 * with `meta`/`wrapped_key` encrypted under a fresh AEK wrapped in the auth keyring's scope key.
 * Returns the blob (addressed by its sha) so a test can serve it from a transport double.
 */
async function seedAttachment(
  s: LocalStore,
  taskId: string,
  filename: string,
  mime: string,
  bytes: Uint8Array,
) {
  const aek = generateAek();
  const { sha, blob } = encryptBlob(aek, bytes);
  const keyring = authKeyring();
  const id = s.newEntityId();
  s.set("attachment", id, "task_id", taskId);
  s.set("attachment", id, "blob_sha", sha);
  s.set("attachment", id, "thumb_sha", null);
  s.set("attachment", id, "blob_size", blob.length);
  s.set(
    "attachment",
    id,
    "wrapped_key",
    wrapAek(aek, keyForScope(keyring, { kind: "personal" }, new Set()), id),
  );
  s.set(
    "attachment",
    id,
    "meta",
    encryptMeta(aek, { filename, mime, plain_sha: await plainSha(bytes) }),
  );
  s.set("attachment", id, "sort_order", 0);
  s.set("attachment", id, "created_at", 1000);
  // The real ciphertext: a download verifies the address before decrypting, so a transport double
  // must serve exactly these bytes, not a lookalike.
  return { id, sha, blob };
}

/** A transport serving the given blobs; anything else 404s exactly like a not-yet-there blob. */
function transportWith(blobs: Record<string, Uint8Array>): BlobTransport {
  return {
    put: async () => "stored" as const,
    get: async (sha) => {
      const blob = blobs[sha];
      if (!blob) throw new ApiError(404, "not found");
      return blob;
    },
  };
}

/** The parent task must exist in the store: the read-time cascade hides attachments whose task is
 * absent or trashed, so a test seeds it exactly like the sync layer would have. */
function seedTask(s: LocalStore, id = "t1") {
  s.set("task", id, "title", "Buy milk");
}

describe("AttachmentsSection", () => {
  it("downloads nothing on open, and fetches a file only when its row is tapped", async () => {
    const s = new LocalStore("test");
    seedTask(s);
    const file = new TextEncoder().encode("quarterly report");
    const here = await seedAttachment(s, "t1", "report.txt", "text/plain", file);
    await seedAttachment(s, "t1", "photo.png", "image/png", new Uint8Array([9, 9, 9]));
    const served = transportWith({ [here.sha]: here.blob });
    const get = jest.fn(served.get);
    const transport = { ...served, get };
    await render(<AttachmentsSection task={baseTask()} />, {
      wrapper: withApp(s, e2eeAuth(transport), { transport }),
    });

    await waitFor(() => expect(screen.getByText("report.txt")).toBeTruthy());
    expect(screen.getByText("photo.png")).toBeTruthy();
    expect(get).not.toHaveBeenCalled();

    // A tap fetches, decrypts and hands the file to open-in.
    await fireEvent.press(screen.getByLabelText("Open report.txt"));
    await waitFor(() => expect(mockFiles.share).toHaveBeenCalledTimes(1));
    expect(mockFiles.share.mock.calls[0]![0]).toEqual(file);
    expect(get).toHaveBeenCalledTimes(1);

    // The withheld blob 404s: the row reads as pending (metadata outran the blob).
    await fireEvent.press(screen.getByLabelText("Open photo.png"));
    await waitFor(() => expect(screen.getAllByText("Pending…")).toHaveLength(1));
  });

  it("does not count a busy server against the row", async () => {
    const s = new LocalStore("test");
    seedTask(s);
    await seedAttachment(s, "t1", "report.txt", "text/plain", new Uint8Array([1]));
    const transport: BlobTransport = {
      put: async () => "stored" as const,
      get: async () => {
        throw new ApiError(503, "server busy, try again shortly");
      },
    };
    await render(<AttachmentsSection task={baseTask()} />, {
      wrapper: withApp(s, e2eeAuth(transport), { transport }),
    });

    await waitFor(() => expect(screen.getByText("report.txt")).toBeTruthy());
    await fireEvent.press(screen.getByLabelText("Open report.txt"));
    await waitFor(() => expect(screen.getByText("Could not open the attachment.")).toBeTruthy());
    expect(screen.queryByText("Pending…")).toBeNull();
  });

  it("opens an image row in the lightbox (unknown mimes fall back to open-in instead)", async () => {
    const s = new LocalStore("test");
    seedTask(s);
    const png = new Uint8Array([137, 80, 78, 71]);
    const seeded = await seedAttachment(s, "t1", "photo.png", "image/png", png);
    const transport = transportWith({ [seeded.sha]: seeded.blob });
    await render(<AttachmentsSection task={baseTask()} />, {
      wrapper: withApp(s, e2eeAuth(transport), { transport }),
    });

    await waitFor(() => expect(screen.getByText("photo.png")).toBeTruthy());
    await fireEvent.press(screen.getByLabelText("Open photo.png"));
    // Both the row and the lightbox image carry the open label; the image is the one with a source.
    await waitFor(() =>
      expect(
        screen
          .getAllByLabelText("Open photo.png")
          .map((n) => n.props.source)
          .filter(Boolean),
      ).toEqual([{ uri: expect.stringContaining("data:image/png;base64,") }]),
    );
    expect(mockFiles.share).not.toHaveBeenCalled();

    // A screen reader user can find the way out, too.
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    expect(screen.getAllByLabelText("Open photo.png").every((n) => !n.props.source)).toBe(true);
  });

  it("picks a file, enqueues it, and releases the metadata op after the first put attempt", async () => {
    const s = new LocalStore("test");
    seedTask(s);
    const picked = new TextEncoder().encode("meeting notes");
    mockPickBytes.current = picked;
    getDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ name: "notes.txt", mimeType: "text/plain", uri: "file:///notes.txt" }],
    });
    const puts: { sha: string; bytes: Uint8Array }[] = [];
    const transport: BlobTransport = {
      put: async (sha, bytes) => {
        puts.push({ sha, bytes: bytes as Uint8Array });
        return "stored" as const;
      },
      get: async () => {
        throw new ApiError(404, "not found");
      },
    };
    await render(<AttachmentsSection task={baseTask()} />, {
      wrapper: withApp(s, e2eeAuth(transport), { transport }),
    });

    await fireEvent.press(screen.getByLabelText("Add attachment"));
    await waitFor(() => expect(screen.getByText("notes.txt")).toBeTruthy());

    // The blob went out under the address the queue computed (whole-body sha of the ciphertext).
    expect(puts).toHaveLength(1);
    expect(puts[0]!.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(puts[0]!.bytes.length).toBe(sealedBlobSize(picked.length)); // header ‖ sealed chunk
    // The picked file was closed once it was sealed.
    expect(mockFiles.close).toHaveBeenCalledTimes(1);

    // The entity carries the plaintext link fields; meta rides encrypted.
    const entity = s.list("attachment").find((e) => e.fields.task_id === "t1");
    expect(entity).toBeDefined();
    expect(entity!.fields.blob_sha).toBe(puts[0]!.sha);
    expect(entity!.fields.thumb_sha).toBeNull();

    // Released to the ordinary outbox after the first settled put attempt: all eight fields.
    const fields = s
      .unsyncedOps()
      .filter((o) => o.entity === "attachment" && o.entityId === entity!.id && o.op === "set")
      .map((o) => (o.op === "set" ? o.field : ""));
    expect(fields).toEqual([
      "task_id",
      "blob_sha",
      "thumb_sha",
      "blob_size",
      "wrapped_key",
      "meta",
      "sort_order",
      "created_at",
    ]);
  });

  it("offers no picker and no plaintext path without an unlocked keyring", async () => {
    const s = new LocalStore("test");
    const locked = fakeAuth({
      session: {
        accessToken: "a",
        refreshToken: "r",
        deviceId: "d",
        user: { id: "me", email: "me@example.com", display_name: "Me" },
      },
    });
    await render(<AttachmentsSection task={baseTask()} />, { wrapper: withApp(s, locked) });

    expect(screen.queryByLabelText("Add attachment")).toBeNull();
    // The client-side E2EE upgrade is gone: nothing may point at it any more.
    expect(screen.queryByLabelText("Learn about E2EE")).toBeNull();
  });

  it("hides rows when the task is trashed (read-time cascade) and on attachment soft-delete", async () => {
    const s = new LocalStore("test");
    seedTask(s);
    await seedAttachment(s, "t1", "report.txt", "text/plain", new Uint8Array([1]));
    await render(<AttachmentsSection task={baseTask()} />, { wrapper: withApp(s, e2eeAuth()) });
    await waitFor(() => expect(screen.getByText("report.txt")).toBeTruthy());

    // Trash the task: its attachments hide with it (no per-device tombstone needed).
    await act(() => {
      s.set("task", "t1", "deleted_at", Date.now());
    });
    await waitFor(() => expect(screen.queryByText("report.txt")).toBeNull());
  });

  it("soft-deletes a row with an undo toast, like a comment", async () => {
    const s = new LocalStore("test");
    seedTask(s);
    await seedAttachment(s, "t1", "report.txt", "text/plain", new Uint8Array([1]));
    await render(<AttachmentsSection task={baseTask()} />, { wrapper: withApp(s, e2eeAuth()) });
    await waitFor(() => expect(screen.getByText("report.txt")).toBeTruthy());

    await fireEvent.press(screen.getByLabelText("Delete attachment"));
    await waitFor(() => expect(screen.queryByText("report.txt")).toBeNull());
    // Soft-delete, not a tombstone: the entity keeps living under a `deleted_at` field.
    expect(s.list("attachment")[0]!.fields.deleted_at).toEqual(expect.any(Number));
  });

  it("renders terminal queue rows as failed and drops them from the device-local queue", async () => {
    const s = new LocalStore("test");
    seedTask(s);
    const persistence = new MemoryPersistence();
    const queue = new AttachmentQueue({
      transport: {
        put: async () => {
          throw new ApiError(413, "attachment exceeds the size cap");
        },
        get: async () => new Uint8Array(),
      },
      persistence,
      keyring: authKeyring(),
      store: s,
      newId: () => s.newEntityId(),
    });
    await queue.enqueue({
      taskId: "t1",
      projectId: null,
      filename: "huge.zip",
      mime: "application/zip",
      source: new Uint8Array([1, 2, 3]),
    });
    await queue.drain(); // 413 is terminal: failed, never released metadata

    await render(<AttachmentsSection task={baseTask()} />, {
      wrapper: withApp(s, e2eeAuth(transportWith({})), {
        transport: transportWith({}),
        persistence,
      }),
    });

    // A queue-only row (no synced metadata exists): failed, with the server's reason.
    await waitFor(() => expect(screen.getByText("huge.zip")).toBeTruthy());
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("attachment exceeds the size cap")).toBeTruthy();
    // Nothing leaked into the outbox: a terminal entry must not publish a blob that can never exist.
    expect(s.unsyncedOps().filter((o) => o.entity === "attachment")).toHaveLength(0);

    // The delete affordance removes the device-local row (there is no entity to soft-delete).
    await fireEvent.press(screen.getByLabelText("Delete attachment"));
    await waitFor(() => expect(screen.queryByText("huge.zip")).toBeNull());
    expect(await persistence.loadAttachmentQueue()).toHaveLength(0);
  });

  it("keeps a transiently-failed enqueue durable across a relaunch and drains on the next trigger", async () => {
    const persistence = new MemoryPersistence();
    const storeA = new LocalStore("a");
    const offline = new AttachmentQueue({
      transport: {
        put: async () => {
          throw new NetworkError("airplane mode");
        },
        get: async () => new Uint8Array(),
      },
      persistence,
      keyring: authKeyring(),
      store: storeA,
      newId: () => storeA.newEntityId(),
      random: () => 0.5,
      now: () => 1_000_000,
    });
    await offline.enqueue({
      taskId: "t1",
      projectId: null,
      filename: "notes.txt",
      mime: "text/plain",
      source: new TextEncoder().encode("meeting notes"),
    });
    await offline.drain();
    // The row survives the "process death" -- the queue is device-local and durable.
    expect(await persistence.loadAttachmentQueue()).toHaveLength(1);

    // Relaunch: `StoreProvider` builds a fresh queue over the same persistence and the sync tail
    // triggers a drain -- the persisted ciphertext uploads, and the row leaves the queue.
    const storeB = new LocalStore("b");
    const relaunched = new AttachmentQueue({
      transport: {
        put: async () => "stored" as const,
        get: async () => new Uint8Array(),
      },
      persistence,
      keyring: authKeyring(),
      store: storeB,
      newId: () => storeB.newEntityId(),
      random: () => 0.5,
      now: () => 9_000_000,
    });
    const summary = await relaunched.drain();
    expect(summary.stored).toBe(1);
    expect(await persistence.loadAttachmentQueue()).toHaveLength(0);
  });

  it("shows nothing when the server has attachments turned off", async () => {
    const s = new LocalStore("test");
    seedTask(s);
    await seedAttachment(s, "t1", "report.txt", "text/plain", new Uint8Array([1]));
    await render(<AttachmentsSection task={baseTask()} />, {
      wrapper: withApp(s, e2eeAuth(), { server: { enabled: false, maxBlobBytes: null } }),
    });
    expect(screen.queryByText("Attachments")).toBeNull();
    expect(screen.queryByLabelText("Add attachment")).toBeNull();
  });

  it("refuses a file over the server's limit before reading it", async () => {
    const s = new LocalStore("test");
    seedTask(s);
    const persistence = new MemoryPersistence();
    getDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ name: "movie.mp4", mimeType: "video/mp4", uri: "file:///m.mp4", size: 5000 }],
    });
    await render(<AttachmentsSection task={baseTask()} />, {
      wrapper: withApp(s, e2eeAuth(), {
        persistence,
        // The largest file whose sealed blob fits: 1000 bytes (21-byte header, one 16-byte tag).
        server: { enabled: true, maxBlobBytes: 1037 },
      }),
    });

    await fireEvent.press(screen.getByLabelText("Add attachment"));
    await waitFor(() =>
      expect(screen.getByText("Too large to attach. The limit is 1000 B.")).toBeTruthy(),
    );
    expect(mockFiles.open).not.toHaveBeenCalled();
    expect(await persistence.listAttachmentQueue()).toHaveLength(0);
  });

  it("retries a failed upload on request", async () => {
    const s = new LocalStore("test");
    seedTask(s);
    mockPickBytes.current = new TextEncoder().encode("notes");
    getDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ name: "notes.txt", mimeType: "text/plain", uri: "file:///notes.txt" }],
    });
    const put = jest
      .fn<Promise<"stored">, [string, AttachmentCiphertext]>()
      .mockRejectedValueOnce(new ApiError(413, "over quota"))
      .mockResolvedValue("stored");
    const transport: BlobTransport = { put, get: transportWith({}).get };
    await render(<AttachmentsSection task={baseTask()} />, {
      wrapper: withApp(s, e2eeAuth(transport), { transport }),
    });

    await fireEvent.press(screen.getByLabelText("Add attachment"));
    await waitFor(() => expect(screen.getByText("Failed")).toBeTruthy());
    await fireEvent.press(screen.getByLabelText("Retry upload"));
    await waitFor(() => expect(screen.queryByText("Failed")).toBeNull());
    expect(put).toHaveBeenCalledTimes(2);
    expect(s.list("attachment")).toHaveLength(1);
  });

  it("clears the queue entry of a synced row whose upload failed when the row is deleted", async () => {
    const s = new LocalStore("test");
    seedTask(s);
    const persistence = new MemoryPersistence();
    let now = 1_000_000;
    const put = jest
      .fn<Promise<"stored">, [string, AttachmentCiphertext]>()
      .mockRejectedValueOnce(new NetworkError("offline"))
      .mockRejectedValueOnce(new ApiError(413, "over quota"));
    const queue = new AttachmentQueue({
      transport: { put, get: async () => new Uint8Array() },
      persistence,
      keyring: authKeyring(),
      store: s,
      newId: () => s.newEntityId(),
      now: () => now,
    });
    await queue.enqueue({
      taskId: "t1",
      projectId: null,
      filename: "huge.zip",
      mime: "application/zip",
      source: new Uint8Array([1, 2, 3]),
    });
    await queue.drain(); // offline: the metadata goes out anyway
    now += 60 * 60_000;
    await queue.drain(); // then the server refuses the blob for good

    await render(<AttachmentsSection task={baseTask()} />, {
      wrapper: withApp(s, e2eeAuth(), { persistence }),
    });
    await waitFor(() => expect(screen.getByText("Failed")).toBeTruthy());
    // The queue is re-read asynchronously after the delete; let that settle inside act.
    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Delete attachment"));
    });
    await waitFor(() => expect(screen.queryByText("huge.zip")).toBeNull());
    expect(await persistence.listAttachmentQueue()).toHaveLength(0);
  });
});
