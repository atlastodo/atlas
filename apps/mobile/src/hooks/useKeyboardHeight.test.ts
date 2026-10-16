import { renderHook, act } from "@testing-library/react-native";
import { Keyboard, Platform, type EmitterSubscription, type KeyboardEvent } from "react-native";
import { useKeyboardHeight } from "./useKeyboardHeight";

type KeyboardEventListener = (event: KeyboardEvent) => void;

describe("useKeyboardHeight", () => {
  beforeEach(() => {
    (Platform as { OS: string }).OS = "ios";
  });

  it("returns 0 initially and updates when keyboard events fire", async () => {
    let showCallback: KeyboardEventListener | undefined;
    let hideCallback: KeyboardEventListener | undefined;

    const addListenerSpy = jest
      .spyOn(Keyboard, "addListener")
      .mockImplementation((event: string, cb: KeyboardEventListener) => {
        if (event === "keyboardWillShow" || event === "keyboardDidShow") {
          showCallback = cb;
        }
        if (event === "keyboardWillHide" || event === "keyboardDidHide") {
          hideCallback = cb;
        }
        return { remove: jest.fn() } as unknown as EmitterSubscription;
      });

    const { result } = await renderHook(() => useKeyboardHeight());
    expect(result.current).toBe(0);

    await act(() => {
      showCallback?.({ endCoordinates: { height: 336 } } as KeyboardEvent);
    });
    expect(result.current).toBe(336);

    await act(() => {
      hideCallback?.({ endCoordinates: { height: 0 } } as KeyboardEvent);
    });
    expect(result.current).toBe(0);

    addListenerSpy.mockRestore();
  });
});
