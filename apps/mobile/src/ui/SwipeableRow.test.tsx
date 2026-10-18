import { Pressable, Text } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { SwipeableRow } from "./SwipeableRow";

/** A swipe's meaning (thresholds, axis lock) lives in `@atlastodo/shared`'s `swipe.ts` and is tested there. */
describe("SwipeableRow", () => {
  it("leaves the wrapped content interactive (a tap is not swallowed by the gesture layer)", async () => {
    const onPress = jest.fn();
    await render(
      <SwipeableRow>
        <Pressable accessibilityRole="button" onPress={onPress}>
          <Text>Buy milk</Text>
        </Pressable>
      </SwipeableRow>,
    );

    await fireEvent.press(screen.getByRole("button"));

    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
