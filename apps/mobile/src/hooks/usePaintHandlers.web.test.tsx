/**
 * @jest-environment jsdom
 */
import { Platform } from "react-native";
// Force the web platform so the shared provider installs its `window` pointerup listener;
// jest-expo defaults to a native OS. Done before any render, which is when the effect reads it.
(Platform as { OS: string }).OS = "web";

import { render, act } from "@testing-library/react-native";
import { View } from "react-native";
import { SelectionProvider, useSelection, type SelectionApi } from "../data/SelectionProvider";
import { usePaintHandlers, type PaintHandlers } from "./usePaintHandlers.web";

/**
 * The web paint seam: handlers only in select mode, a drag selects, and the anchor's trailing click is swallowed
 * after a moved paint. The range maths is `SelectionProvider.test`.
 */
const handlers: Record<string, PaintHandlers> = {};
let api: SelectionApi | null = null;

function Row({ id }: { id: string }) {
  handlers[id] = usePaintHandlers(id, useSelection().mode);
  return <View />;
}
function Capture() {
  api = useSelection();
  return null;
}

async function mount() {
  await render(
    <SelectionProvider>
      <Capture />
      <Row id="a" />
      <Row id="b" />
      <Row id="c" />
      <Row id="d" />
    </SelectionProvider>,
  );
  return () => api as SelectionApi;
}

// The handlers ignore the event object, so a bare cast is enough to invoke them.
const evt = undefined as never;

describe("usePaintHandlers.web", () => {
  it("returns no handlers outside select mode", async () => {
    await mount();
    expect(handlers["a"]).toEqual({});
  });

  it("exposes the row's id as a data-atlas-row marker in select mode (for the pointermove hit-test)", async () => {
    const get = await mount();
    await act(() => get().enter());
    expect(handlers["b"]!.dataSet).toEqual({ atlasRow: "b" });
  });

  it("wires pointer down/enter to paint a range in select mode", async () => {
    const get = await mount();
    await act(() => {
      get().setVisibleIds(["a", "b", "c", "d"]);
      get().beginWith("a"); // enter select mode with "a" selected
    });
    expect(typeof handlers["b"]!.onPointerDown).toBe("function");

    await act(() => handlers["b"]!.onPointerDown?.(evt)); // anchor at b
    await act(() => handlers["c"]!.onPointerEnter?.(evt)); // drag across c
    expect([...get().selected].sort()).toEqual(["a", "b", "c"]);
  });

  it("swallows the anchor's trailing click after a moved paint + pointer release", async () => {
    const get = await mount();
    await act(() => {
      get().setVisibleIds(["a", "b", "c", "d"]);
      get().beginWith("a");
    });
    await act(() => handlers["b"]!.onPointerDown?.(evt));
    await act(() => handlers["c"]!.onPointerEnter?.(evt));
    // Outside act: the release only sets refs, and the browser's click follows in the same task,
    // before the zero-delay timer that disarms an unused swallow. An async act could run that timer.
    window.dispatchEvent(new Event("pointerup"));
    expect(get().paintConsumeClick("b")).toBe(true);
    // Disarmed after one read, so a later select toggles normally.
    expect(get().paintConsumeClick("b")).toBe(false);
  });
});
