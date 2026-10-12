# Accessibility

Atlas Todo should be usable with a keyboard, a screen reader, larger text and reduced motion. The
target is [WCAG 2.2](https://www.w3.org/TR/WCAG22/) level AA on every platform the project ships:
the web app, Android and the Linux desktop app. iOS is not published, so it is not tested.

Nobody has audited the app yet. What is below is what the code does and what is known to be
missing.

## What the app does

- **Names and roles:** buttons, toggles, fields and icon-only controls carry an accessible name
  and role (`accessibilityLabel` and `accessibilityRole`); the tests find controls by role and
  name, so a missing label fails them.
- **Keyboard (web and desktop):** every control is reachable with Tab and shows an accent focus
  ring. Lists move with the arrow keys, Enter opens and Escape closes. Ctrl/Cmd+K opens the
  command palette, and `?` lists every shortcut.
- **Reordering without dragging:** wherever tasks, habits or steps can be dragged, a menu offers
  "Move up" and "Move down".
- **Motion:** with the system's reduce-motion setting on, animations and skeleton shimmer stop.
- **Language:** on the web, the page's language follows the UI language, so a screen reader reads
  Danish as Danish.
- **Contrast:** body and secondary text, placeholders and every accent colour's buttons are at
  least 4.5:1 against their background; a test checks the accent colours.
- **Status updates:** toasts, sync status, the focus timer and sign-in errors are announced to
  screen readers.

## Known gaps

- Single-key shortcuts (such as `J`, `K`, `A`, `C`, `T` on the web) can't be turned off or
  remapped, which gets in the way of speech input (WCAG 2.1.4).
- Some placeholder text in dark mode is below 4.5:1.
- Charts in Stats are summarized in their accessible label but have no table view.
- No one has tested the app end to end with TalkBack, NVDA or Orca yet. Reports from people who
  use them are especially welcome.

## Reporting a problem

Open an [accessibility issue](https://github.com/atlastodo/atlas-todo/issues/new?template=accessibility.yml).
Say what you tried to do, what happened, and which device, browser and assistive technology (and
versions) you use. Accessibility bugs that block a task are treated like any other bug that
blocks a task: they come first.

## For contributors

A UI change should keep the above true. Check it with the keyboard alone, give new controls a
name and role, don't use colour as the only signal, and keep text at 4.5:1. The
[pull request template](./.github/PULL_REQUEST_TEMPLATE.md) has the checklist item.
