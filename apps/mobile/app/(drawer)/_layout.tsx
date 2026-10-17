import { useCallback, useMemo, useState } from "react";
import { useColorScheme } from "nativewind";
import { useTranslation } from "react-i18next";
import { Drawer } from "expo-router/drawer";
import { router, useGlobalSearchParams, usePathname, type ErrorBoundaryProps } from "expo-router";
import {
  ACCENTS,
  DEFAULT_FILTER_ICON,
  DEFAULT_FOLDER_ICON,
  flattenProjectTree,
  projectAncestors,
  projectDescendantIds,
  purge,
  resolveProjectColor,
} from "@atlastodo/shared";
import { DRAWER_EXTRA, FEATURE_VIEWS, NAV, PRIMARY_TABS, viewPath } from "../../src/nav/navModel";
import type { SmartView } from "../../src/nav/navModel";
import {
  folderMenuItems,
  projectMenuItems,
  type ProjectMenuDeps,
  type ProjectMenuTarget,
} from "../../src/nav/projectMenus";
import { useInviteToasts, useNotifications } from "../../src/data/NotificationsProvider";
import { useAuth } from "../../src/auth/AuthContext";
import { useStore } from "../../src/data/StoreProvider";
import { useToast } from "../../src/data/ToastProvider";
import { useFeature } from "../../src/hooks/useFeature";
import { useIsTablet, useIsWide } from "../../src/hooks/useIsWide";
import { usePreferences } from "../../src/hooks/usePreferences";
import { useProjectMembers } from "../../src/hooks/useProjectMembers";
import { useProjects } from "../../src/hooks/useProjects";
import { useSavedFilters } from "../../src/hooks/useSavedFilters";
import { useSidebar } from "../../src/data/SidebarContext";
import { useAutoReport } from "../../src/hooks/useAutoReport";
import { CrashScreen } from "../../src/ui/CrashScreen";
import { AppDrawerContent, type SidebarSection } from "../../src/ui/AppDrawerContent";
import { SettingsSidebar } from "../../src/ui/SettingsSidebar";
import { MobileBottomNav } from "../../src/ui/MobileBottomNav";
import { MobileMenuModal } from "../../src/ui/MobileMenuModal";
import type { ContextMenuItem } from "../../src/ui/ContextMenu";
import { ConfirmDialog } from "../../src/ui/ConfirmDialog";
import { SyncStatusBadge } from "../../src/ui/SyncStatusBadge";
import { SidebarToggle } from "../../src/ui/SidebarToggle";
import { FolderPicker } from "../../src/ui/FolderPicker";
import { CreateProjectSheet } from "../../src/ui/CreateProjectSheet";
import { projectIconFor } from "../../src/ui/projectIcons";
import { drawerThemeOptions, headerThemeOptions } from "../../src/theme/navTheme";
import { Platform, Pressable, type ViewStyle } from "react-native";
import {
  CopyPlus,
  House,
  Info,
  Settings,
  SquareArrowOutUpRight,
  Star,
  StarOff,
  Trash2,
  X,
} from "../../src/ui/icons";

export const unstable_settings = {
  initialRouteName: "(tabs)",
};

/**
 * The app's shell: below the wide breakpoint (a phone, native or web alike) the three primary lists
 * are a bottom bar whose Menu tab opens {@link MobileMenuModal} with the rest. On a wide viewport
 * (`useIsWide`) the drawer becomes a permanent sidebar and the bar hides; a tablet's sidebar starts
 * as the icon rail (`SidebarContext`). Only `drawerType` changes by width, never a forked screen.
 *
 * The nav list is a custom `drawerContent` ({@link AppDrawerContent}) built from `navModel`, so the
 * wide sidebar lists every smart list individually. A disabled feature's row is filtered out of the
 * sections here. The drawer is nested inside the root Stack so a detail screen can push over the
 * whole shell.
 */
export default function DrawerLayout() {
  const { t } = useTranslation();
  const isWide = useIsWide();
  const isTablet = useIsTablet();
  const isWeb = Platform.OS === "web";
  // Phone-width web navigates like the native app: bottom bar, menu modal and add button.
  const isPhone = !isWide;
  const { colorScheme: scheme } = useColorScheme();
  const { collapsed, toggle: toggleSidebar } = useSidebar();
  const pathname = usePathname();
  // While Settings is open on a wide viewport the sidebar becomes its section nav
  // (`SettingsSidebar`), selected by the same `?section=` the page reads.
  const { section: settingsSection } = useGlobalSearchParams<{ section?: string }>();
  const settingsNav = isWide && pathname === "/settings";
  // Collapsed shrinks the wide sidebar to an icon-only rail; a phone always uses the overlay.
  const railed = isWide && collapsed;
  const { count: notificationCount } = useNotifications();
  useInviteToasts(() => router.push("/notifications"));
  const { store, kick } = useStore();
  const toast = useToast();
  const {
    projects,
    folders,
    duplicateProject,
    setProjectArchived,
    setProjectParent,
    removeProject,
  } = useProjects();
  const { filters, createFilter, removeFilter } = useSavedFilters();
  const {
    accent,
    defaultView,
    setDefaultView,
    folderExpanded,
    setFolderExpanded,
    isFavorite,
    toggleFavorite,
    favorites,
    projectPinned,
    smartViewInMenu,
  } = usePreferences();
  // The project/folder whose "Move to folder" picker is open, or null.
  const [movingId, setMovingId] = useState<string | null>(null);
  // The folder a sidebar "New project here" was picked on; `undefined` while the sheet is closed.
  const [creatingIn, setCreatingIn] = useState<string | undefined>(undefined);
  const [menuModalOpen, setMenuModalOpen] = useState(false);
  // The shared project/folder whose leave confirm is open, or null. Leaving is a member's only way
  // out (see `projectMenus`): the server turns the removal into a tombstone every device receives.
  const [leaving, setLeaving] = useState<ProjectMenuTarget | null>(null);
  const { isOwner } = useProjectMembers();
  const { api, session } = useAuth();

  // Not locally undoable, hence the confirm. Mirrors `ProjectsScreen.leaveProject`.
  const leaveProject = async (target: ProjectMenuTarget) => {
    setLeaving(null);
    const myId = session?.user.id;
    if (!myId) return;
    try {
      await api.removeMember(target.id, myId);
      if (pathname === `/project/${target.id}`) router.push(viewPath(defaultView));
      kick();
      toast.show(t("toast.projectLeft"));
    } catch {
      toast.show(t("toast.leaveFailed"));
    }
  };

  // Right-click menus (web only). The project/folder menus are pure builders in
  // `src/nav/projectMenus`, where the owner-only delete/archive rule lives; their effects are these
  // injected actions. Mutating actions show an undo toast; leave confirms instead.
  const menuDeps = useMemo<ProjectMenuDeps>(
    () => ({
      t,
      isOwner,
      isFavorite,
      onToggleFavorite: (key, wasFavorite) => {
        toggleFavorite(key);
        toast.show(wasFavorite ? t("toast.favRemoved") : t("toast.favAdded"));
      },
      onOpen: (id) => router.push(`/project/${id}`),
      onDuplicate: (id) => {
        const { newId, undo } = duplicateProject(id);
        router.push(`/project/${newId}`);
        toast.show(t("toast.duplicated", { count: 1 }), {
          label: t("common.undo"),
          run: () => {
            undo();
            router.push(viewPath(defaultView));
          },
        });
      },
      onNewProjectHere: (folderId) => setCreatingIn(folderId),
      onMoveToFolder: (id) => setMovingId(id),
      onArchive: ({ id, name }) => {
        setProjectArchived(id, true);
        toast.show(t("toast.projectArchived", { name }), {
          label: t("common.undo"),
          run: () => setProjectArchived(id, false),
        });
      },
      onDelete: ({ id, name, kind }) => {
        const undo = removeProject(id);
        // Leave the deleted project's own screen.
        if (pathname === `/project/${id}`) router.push(viewPath(defaultView));
        toast.show(
          kind === "folder"
            ? t("toast.folderDeleted", { name })
            : t("toast.projectDeleted", { name }),
          { label: t("common.undo"), run: undo },
        );
      },
      onLeave: (target) => setLeaving(target),
    }),
    [
      t,
      toast,
      isOwner,
      isFavorite,
      toggleFavorite,
      duplicateProject,
      setProjectArchived,
      removeProject,
      pathname,
      defaultView,
    ],
  );

  const projectMenu = useCallback(
    (id: string, name: string) => projectMenuItems(menuDeps, id, name),
    [menuDeps],
  );

  // A folder's menu is about the folder: open it, add a project inside, or delete it (which hides
  // the whole subtree via the read cascade and undoes as one write).
  const folderMenu = useCallback(
    (id: string, name: string) => folderMenuItems(menuDeps, id, name),
    [menuDeps],
  );

  const moving = useMemo(
    () => [...projects, ...folders].find((p) => p.id === movingId) ?? null,
    [projects, folders, movingId],
  );

  const filterMenu = useCallback(
    (id: string, name: string, query: string): ContextMenuItem[] => {
      const fav = isFavorite(`filter:${id}`);
      return [
        {
          key: "open",
          label: t("context.open"),
          icon: SquareArrowOutUpRight,
          onPress: () => router.push(`/filter/${id}`),
        },
        {
          key: "favorite",
          label: fav ? t("context.removeFromFav") : t("context.addToFav"),
          icon: fav ? StarOff : Star,
          onPress: () => {
            toggleFavorite(`filter:${id}`);
            toast.show(fav ? t("toast.favRemoved") : t("toast.favAdded"));
          },
        },
        {
          key: "duplicate",
          label: t("common.duplicate"),
          icon: CopyPlus,
          onPress: () => {
            const nid = createFilter(`${name} (copy)`, query);
            router.push(`/filter/${nid}`);
            toast.show(t("toast.duplicated", { count: 1 }), {
              label: t("common.undo"),
              run: () => {
                // Hard-remove the copy; a soft-delete would leave it in Trash.
                purge(store, kick, "saved_filter", nid);
                if (pathname === `/filter/${nid}`) router.push(viewPath(defaultView));
              },
            });
          },
        },
        {
          key: "delete",
          label: t("common.delete"),
          icon: Trash2,
          separatorBefore: true,
          danger: true,
          onPress: () => {
            const undo = removeFilter(id);
            if (pathname === `/filter/${id}`) router.push(viewPath(defaultView));
            toast.show(t("toast.filterDeleted", { name }), { label: t("common.undo"), run: undo });
          },
        },
      ];
    },
    [
      t,
      toast,
      defaultView,
      pathname,
      store,
      kick,
      isFavorite,
      toggleFavorite,
      createFilter,
      removeFilter,
    ],
  );

  const smartViewMenu = useCallback(
    (view: SmartView): ContextMenuItem[] => {
      const fav = isFavorite(`view:${view}`);
      return [
        {
          key: "favorite",
          label: fav ? t("context.removeFromFav") : t("context.addToFav"),
          icon: fav ? StarOff : Star,
          onPress: () => {
            toggleFavorite(`view:${view}`);
            toast.show(fav ? t("toast.favRemoved") : t("toast.favAdded"));
          },
        },
        {
          key: "home",
          label: t("context.setHome"),
          icon: House,
          onPress: () => {
            setDefaultView(view);
            toast.show(t("toast.homeSet"));
          },
        },
      ];
    },
    [t, toast, isFavorite, toggleFavorite, setDefaultView],
  );

  const extraViewMenu = useCallback(
    (name: string): ContextMenuItem[] => {
      const fav = isFavorite(`view:${name}`);
      return [
        {
          key: "favorite",
          label: fav ? t("context.removeFromFav") : t("context.addToFav"),
          icon: fav ? StarOff : Star,
          onPress: () => {
            toggleFavorite(`view:${name}`);
            toast.show(fav ? t("toast.favRemoved") : t("toast.favAdded"));
          },
        },
      ];
    },
    [t, toast, isFavorite, toggleFavorite],
  );

  // A disabled feature's route is still declared below; only its sidebar row is omitted.
  const habitsOn = useFeature("habits");
  const focusOn = useFeature("focus");
  const statsOn = useFeature("stats");
  const countdownsOn = useFeature("countdowns");
  const flags: Record<string, boolean> = useMemo(
    () => ({ habits: habitsOn, focus: focusOn, stats: statsOn, countdowns: countdownsOn }),
    [habitsOn, focusOn, statsOn, countdownsOn],
  );

  // Folders above the open project are forced open so the active row is never hidden.
  const collapsedFolders = useMemo(() => {
    const all = [...projects, ...folders];
    const openId = pathname.startsWith("/project/") ? pathname.slice("/project/".length) : null;
    const forced = new Set(openId ? projectAncestors(all, openId).map((a) => a.id) : []);
    return new Set(
      folders.filter((f) => !folderExpanded(f.id) && !forced.has(f.id)).map((f) => f.id),
    );
  }, [projects, folders, pathname, folderExpanded]);

  // Order: smart lists, favorites, utility + enabled feature views, projects, filters, history, settings.
  const sections: SidebarSection[] = useMemo(() => {
    // Completed, Archive and Recently deleted live in one "history" section.
    const HISTORY_VIEWS: SmartView[] = ["completed"];
    const HISTORY_EXTRAS = ["archive", "trash"];

    const smart = NAV.filter(
      (n) =>
        !HISTORY_VIEWS.includes(n.view) &&
        (smartViewInMenu(n.view) || pathname === viewPath(n.view)),
    ).map((n) => ({
      key: n.view,
      label: t(n.labelKey, n.label),
      icon: n.icon,
      href: viewPath(n.view),
      menuItems: smartViewMenu(n.view),
    }));
    const extras = DRAWER_EXTRA.filter(
      (e) => !HISTORY_EXTRAS.includes(e.name) && e.name !== "about",
    ).map((e) => ({
      key: e.name,
      label: t(e.labelKey, e.label),
      icon: e.icon,
      href: `/${e.name}`,
      badge: e.name === "notifications" ? notificationCount : undefined,
      menuItems: extraViewMenu(e.name),
    }));
    const history = [
      ...NAV.filter(
        (n) =>
          HISTORY_VIEWS.includes(n.view) &&
          (smartViewInMenu(n.view) || pathname === viewPath(n.view)),
      ).map((n) => ({
        key: n.view,
        label: t(n.labelKey, n.label),
        icon: n.icon,
        href: viewPath(n.view),
        menuItems: smartViewMenu(n.view),
      })),
      ...DRAWER_EXTRA.filter((e) => HISTORY_EXTRAS.includes(e.name)).map((e) => ({
        key: e.name,
        label: t(e.labelKey, e.label),
        icon: e.icon,
        href: `/${e.name}`,
        menuItems: extraViewMenu(e.name),
      })),
    ];
    const features = FEATURE_VIEWS.filter((f) => flags[f.flag]).map((f) => ({
      key: f.name,
      label: t(f.labelKey, f.label),
      icon: f.icon,
      href: `/${f.name}`,
      menuItems: extraViewMenu(f.name),
    }));

    const allProjectsAndFolders = [...projects, ...folders];
    const openProjectId = pathname.startsWith("/project/")
      ? pathname.slice("/project/".length)
      : null;
    const forcedOpenIds = new Set(
      openProjectId
        ? [
            openProjectId,
            ...projectAncestors(allProjectsAndFolders, openProjectId).map((a) => a.id),
          ]
        : [],
    );
    const keptProjectsAndFolders = allProjectsAndFolders.filter(
      (p) => projectPinned(p.id) || forcedOpenIds.has(p.id),
    );

    // The icon-only rail shows a flat list: it cannot express a tree, and a folder row navigates nowhere.
    const tree = flattenProjectTree(keptProjectsAndFolders, collapsedFolders);
    const visibleTree = railed ? tree.filter((r) => r.project.kind === "project") : tree;
    const projectItems = visibleTree.map(({ project: p, depth, hasChildren }) => ({
      key: `project-${p.id}`,
      label: p.name,
      icon: projectIconFor(p.icon || (p.kind === "folder" ? DEFAULT_FOLDER_ICON : undefined)),
      href: p.kind === "folder" ? null : `/project/${p.id}`,
      depth: railed ? 0 : depth,
      expanded: p.kind === "folder" ? folderExpanded(p.id) : undefined,
      onToggle:
        p.kind === "folder" && hasChildren
          ? () => setFolderExpanded(p.id, !folderExpanded(p.id))
          : undefined,
      tint: resolveProjectColor(p),
      menuItems: p.kind === "folder" ? folderMenu(p.id, p.name) : projectMenu(p.id, p.name),
    }));
    const filterItems = filters.map((f) => ({
      key: `filter-${f.id}`,
      label: f.name,
      icon: projectIconFor(f.icon || DEFAULT_FILTER_ICON),
      href: `/filter/${f.id}`,
      tint: resolveProjectColor(f),
      menuItems: filterMenu(f.id, f.name, f.query),
    }));

    const favoriteItems: SidebarSection["items"] = [];

    for (const n of NAV) {
      if (favorites[`view:${n.view}`]) {
        favoriteItems.push({
          key: `fav-view-${n.view}`,
          label: t(n.labelKey, n.label),
          icon: n.icon,
          href: viewPath(n.view),
          menuItems: smartViewMenu(n.view),
        });
      }
    }

    for (const e of DRAWER_EXTRA) {
      if (favorites[`view:${e.name}`]) {
        favoriteItems.push({
          key: `fav-view-${e.name}`,
          label: t(e.labelKey, e.label),
          icon: e.icon,
          href: `/${e.name}`,
          badge: e.name === "notifications" ? notificationCount : undefined,
          menuItems: extraViewMenu(e.name),
        });
      }
    }

    for (const f of FEATURE_VIEWS) {
      if (flags[f.flag] && favorites[`view:${f.name}`]) {
        favoriteItems.push({
          key: `fav-view-${f.name}`,
          label: t(f.labelKey, f.label),
          icon: f.icon,
          href: `/${f.name}`,
          menuItems: extraViewMenu(f.name),
        });
      }
    }

    for (const p of [...projects, ...folders]) {
      if (favorites[`project:${p.id}`]) {
        favoriteItems.push({
          key: `fav-project-${p.id}`,
          label: p.name,
          icon: projectIconFor(p.icon || (p.kind === "folder" ? DEFAULT_FOLDER_ICON : undefined)),
          href: p.kind === "folder" ? null : `/project/${p.id}`,
          depth: 0,
          tint: resolveProjectColor(p),
          menuItems: p.kind === "folder" ? folderMenu(p.id, p.name) : projectMenu(p.id, p.name),
        });
      }
    }

    for (const f of filters) {
      if (favorites[`filter:${f.id}`]) {
        favoriteItems.push({
          key: `fav-filter-${f.id}`,
          label: f.name,
          icon: projectIconFor(f.icon || DEFAULT_FILTER_ICON),
          href: `/filter/${f.id}`,
          tint: resolveProjectColor(f),
          menuItems: filterMenu(f.id, f.name, f.query),
        });
      }
    }

    const settings = [
      { key: "settings", label: t("common.settings"), icon: Settings, href: "/settings" },
      { key: "about", label: t("nav.about", "About"), icon: Info, href: "/about" },
    ];
    return [
      { key: "smart", items: smart },
      ...(favoriteItems.length > 0 ? [{ key: "favorites", items: favoriteItems }] : []),
      { key: "utility", items: [...extras, ...features] },
      ...(projectItems.length > 0 ? [{ key: "projects", items: projectItems }] : []),
      ...(filterItems.length > 0 ? [{ key: "filters", items: filterItems }] : []),
      { key: "history", items: history },
      { key: "settings", items: settings },
    ];
  }, [
    t,
    notificationCount,
    projects,
    folders,
    filters,
    favorites,
    collapsedFolders,
    folderExpanded,
    setFolderExpanded,
    railed,
    flags,
    projectMenu,
    folderMenu,
    filterMenu,
    smartViewMenu,
    extraViewMenu,
    pathname,
    projectPinned,
    smartViewInMenu,
  ]);

  return (
    <>
      <Drawer
        // Drawer screens are siblings, and the default `firstRoute` sends every Back to `(tabs)`.
        // `fullHistory` keeps the last visited route, so the browser's stack and the navigator's agree.
        backBehavior="fullHistory"
        drawerContent={(props) => {
          const chrome = {
            brand: "Atlas Todo",
            onBrandPress: () => {
              if (!isWide) props.navigation.closeDrawer();
              router.push(viewPath(defaultView));
            },
            statusSlot: <SyncStatusBadge />,
            // The overlay drawer closes rather than collapsing into a rail.
            action: isWide ? (
              <SidebarToggle />
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("common.close")}
                onPress={() => props.navigation.closeDrawer()}
                hitSlop={8}
                className="p-1 web:cursor-pointer"
              >
                <X size={20} className="text-neutral-500 dark:text-neutral-400" />
              </Pressable>
            ),
            collapsed: railed,
          };
          if (settingsNav) {
            return (
              <SettingsSidebar
                {...chrome}
                section={settingsSection}
                onSelectSection={(id) => router.setParams({ section: id, tab: undefined })}
                // A cold deep link has nothing to go back to, so it lands on the home view.
                onBack={() =>
                  router.canGoBack() ? router.back() : router.replace(viewPath(defaultView))
                }
              />
            );
          }
          return (
            <AppDrawerContent
              {...chrome}
              sections={sections}
              activeHref={pathname}
              onNavigate={(href) => {
                // Only the overlay drawer closes; the wide sidebar is permanent. A tablet's expanded
                // sidebar folds back into the rail, handing the room back to the page just opened.
                if (!isWide) props.navigation.closeDrawer();
                else if (isTablet && !collapsed) toggleSidebar();
                router.push(href);
              }}
            />
          );
        }}
        screenOptions={{
          headerTitleAlign: "left",
          drawerType: isWide ? "permanent" : "front",
          // A phone, native or web, navigates by the bottom bar and menu modal: no swipe, no hamburger.
          swipeEnabled: false,
          headerLeft: () => null,
          ...headerThemeOptions(scheme),
          // On web the lib only attaches a CSS transition to the overlay drawer, so a permanent
          // sidebar's rail <-> full collapse would snap. drawerStyle is last in the lib's style
          // array, so the transition declared here lands on the drawer element. Native has no
          // `transition` style.
          drawerStyle: {
            ...drawerThemeOptions(scheme).drawerStyle,
            ...(isWide ? { width: railed ? 72 : 288 } : { width: 288 }),
            ...(isWeb
              ? ({
                  transition: isWide ? "width 0.3s ease" : "transform 0.3s ease",
                } as ViewStyle)
              : null),
          },
          sceneStyle: drawerThemeOptions(scheme).sceneStyle,
        }}
      >
        <Drawer.Screen name="(tabs)" options={{ title: t("nav.tasks"), headerShown: false }} />
        {NAV.filter((item) => !PRIMARY_TABS.includes(item.view)).map((item) => (
          <Drawer.Screen
            key={item.view}
            name={item.view}
            options={{ title: t(item.labelKey, item.label) }}
          />
        ))}
        {DRAWER_EXTRA.map((item) => (
          <Drawer.Screen
            key={item.name}
            name={item.name}
            options={{ title: t(item.labelKey, item.label) }}
          />
        ))}
        {FEATURE_VIEWS.map((item) => (
          <Drawer.Screen
            key={item.name}
            name={item.name}
            options={{ title: t(item.labelKey, item.label) }}
          />
        ))}
        <Drawer.Screen name="settings" options={{ title: t("common.settings") }} />
        <Drawer.Screen name="onboarding" options={{ title: t("onboarding.welcomeTitle") }} />
        {/* Drawer screens rather than pushed routes, so the sidebar/hamburger stays. */}
        <Drawer.Screen name="project/[id]" options={{ title: t("nav.projects") }} />
        <Drawer.Screen name="filter/[id]" options={{ title: t("nav.filters") }} />
        <Drawer.Screen name="habit/[id]" options={{ title: t("nav.habits") }} />
      </Drawer>

      {isPhone && (
        <MobileBottomNav
          activePath={pathname}
          onNavigate={(href) => router.push(href)}
          onOpenMenu={() => setMenuModalOpen(true)}
          isMenuOpen={menuModalOpen}
          accentColor={ACCENTS[accent][600]}
        />
      )}

      {isPhone && (
        <MobileMenuModal
          visible={menuModalOpen}
          onClose={() => setMenuModalOpen(false)}
          sections={sections}
          activeHref={pathname}
          onNavigate={(href) => router.push(href)}
          statusSlot={<SyncStatusBadge />}
        />
      )}

      {/* Outside the Drawer, whose children must be Screens. */}
      <CreateProjectSheet
        visible={creatingIn !== undefined}
        parentId={creatingIn ?? null}
        onClose={() => setCreatingIn(undefined)}
        onCreated={(id) => router.push(`/project/${id}`)}
      />
      <FolderPicker
        visible={moving != null}
        folders={folders}
        currentParentId={moving?.parent_id ?? null}
        disabledIds={
          moving
            ? new Set([moving.id, ...projectDescendantIds([...projects, ...folders], moving.id)])
            : new Set<string>()
        }
        onPick={(parentId) => {
          if (!moving) return;
          const undo = setProjectParent(moving.id, parentId);
          if (!undo) {
            toast.show(t("projects.moveCycle"));
            return;
          }
          toast.show(t("toast.movedToFolder"), { label: t("common.undo"), run: undo });
        }}
        onClose={() => setMovingId(null)}
      />

      {/* Leaving is not locally reversible (only a re-invite brings it back), so it confirms. */}
      <ConfirmDialog
        visible={leaving != null}
        title={t("workspace.leaveProjectTitle")}
        message={t("workspace.leaveProjectMessage", { name: leaving?.name ?? "" })}
        confirmLabel={t("workspace.leaveProject")}
        danger
        onConfirm={() => leaving && void leaveProject(leaving)}
        onCancel={() => setLeaving(null)}
      />
    </>
  );
}

/**
 * Catches a throw from any drawer screen. It sits below StoreProvider and the sync client, so they
 * stay mounted and `retry()` re-renders only this subtree. Only an error above the drawer reaches
 * the root boundary in `app/_layout.tsx`.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const report = useAutoReport(error);
  if (__DEV__) console.error(error);
  return (
    <CrashScreen
      error={error}
      report={report}
      onRetry={() => void retry()}
      onGoHome={() => router.replace("/today")}
    />
  );
}
