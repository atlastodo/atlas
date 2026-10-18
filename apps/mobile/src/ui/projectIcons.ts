/**
 * Project icons for the phone. Icon names are canonical in `@atlastodo/shared` (`PROJECT_ICON_NAMES`);
 * this maps each to its lucide-react-native component, deep-imported and run through NativeWind's
 * `cssInterop` like `ui/icons.ts`. Keys match the shared names even where lucide 1.x renamed the
 * icon (`home` is `house`, `book` is `book-open`).
 */

import { cssInterop } from "nativewind";
import type { LucideIcon } from "lucide-react-native";
import { PROJECT_ICON_NAMES } from "@atlastodo/shared";

import Hash from "lucide-react-native/icons/hash";
import ListFilter from "lucide-react-native/icons/list-filter";
import Briefcase from "lucide-react-native/icons/briefcase";
import House from "lucide-react-native/icons/house";
import Heart from "lucide-react-native/icons/heart";
import Star from "lucide-react-native/icons/star";
import BookOpen from "lucide-react-native/icons/book-open";
import Code from "lucide-react-native/icons/code";
import Music from "lucide-react-native/icons/music";
import ShoppingCart from "lucide-react-native/icons/shopping-cart";
import Plane from "lucide-react-native/icons/plane";
import Dumbbell from "lucide-react-native/icons/dumbbell";
import GraduationCap from "lucide-react-native/icons/graduation-cap";
import Palette from "lucide-react-native/icons/palette";
import Rocket from "lucide-react-native/icons/rocket";
import Coffee from "lucide-react-native/icons/coffee";
import Leaf from "lucide-react-native/icons/leaf";
import Folder from "lucide-react-native/icons/folder";

export const PROJECT_ICONS: Record<string, LucideIcon> = {
  filter: ListFilter,
  hash: Hash,
  briefcase: Briefcase,
  home: House,
  heart: Heart,
  star: Star,
  book: BookOpen,
  code: Code,
  music: Music,
  cart: ShoppingCart,
  plane: Plane,
  dumbbell: Dumbbell,
  school: GraduationCap,
  palette: Palette,
  rocket: Rocket,
  coffee: Coffee,
  leaf: Leaf,
  folder: Folder,
};

for (const icon of Object.values(PROJECT_ICONS)) {
  cssInterop(icon, {
    className: { target: "style", nativeStyleToProp: { color: true, opacity: true } },
  });
}

// Fail loud in dev if a shared name has no component here.
if (process.env.NODE_ENV !== "production") {
  for (const name of PROJECT_ICON_NAMES) {
    if (!PROJECT_ICONS[name]) console.warn(`projectIcons: no component for "${name}"`);
  }
}

/** Resolve an icon name to its component, falling back to the default hash (also used for saved filters). */
export function projectIconFor(name: string | undefined): LucideIcon {
  return (name ? PROJECT_ICONS[name] : undefined) ?? Hash;
}
