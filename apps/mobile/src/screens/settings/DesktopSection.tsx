import { CloseToTrayRow } from "../../ui/CloseToTrayRow";
import { DesktopUpdateSection } from "../../ui/DesktopUpdateSection";

/** The desktop app's own settings; the section is only listed inside the desktop app. */
export function DesktopSection() {
  return (
    <>
      <CloseToTrayRow />
      <DesktopUpdateSection />
    </>
  );
}
