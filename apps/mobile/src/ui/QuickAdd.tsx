import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type TextInputKeyPressEvent,
  type TextInputSelectionChangeEvent,
  type TextInputInstance,
  type ViewInstance,
} from "react-native";
import { useTranslation } from "react-i18next";
import type { CreateTaskInput } from "@atlastodo/client-core";
import { parseQuickAdd } from "@atlastodo/shared";
import { ArrowUp, Check, Hash, Plus, Tag } from "./icons";
import { chipColors } from "./chips";
import { TaskComposeBar } from "./TaskComposeBar";
import { ADD_TASK_SUBMIT } from "../lib/submitBehavior";
import { composeInput, composeValue, mergeDraft, type ComposeDraft } from "../lib/composeDraft";
import { isEscapeKey } from "../hooks/useCancelOnEscape";
import { useQuickAddMorningReminder } from "../hooks/useReminders";
import { useQuickAddHotkeyTarget } from "../data/CursorProvider";
import { haptics } from "../lib/haptics";

/**
 * Quick-add with natural-language parsing: type a title carrying dates, `#project`, `@label`,
 * `p1..p4` or a recurrence phrase and a chip row previews what will be set. Parsing is
 * `@atlastodo/shared`'s `parseQuickAdd`.
 *
 * A task created here that is all-day gets an implicit 09:00 reminder
 * (`useQuickAddMorningReminder`, gated on the reminders master toggle); no other creation path does.
 *
 * The preview row is also the input row (`TaskComposeBar`, values from `lib/composeDraft`). It
 * shows while the field is focused, except for the blur a chip press itself causes.
 *
 * The recognised date span (`parsed.dateMatch`) is boxed by a transparent-text mirror behind the
 * input (`MIRROR_TEXT`). Backspace right after the box unlinks it via `ignoreDates` (web only, no
 * key events on native; there the due chip's X does it). The ignore is forgotten once the phrase
 * leaves the text.
 *
 * Typing `#pro` or `@err` opens a suggestion popover. On web the first row is highlighted, arrows
 * move it and Enter accepts; Escape closes the popover first and cancels the draft second. The phone
 * picks by tap, since picking would blur the input and close the keyboard.
 */

/**
 * Stacking layers for the input vs its highlight overlay. The input must sit above the overlay so
 * typed text is not painted over. Exported for a test.
 */
const HIGHLIGHT_LAYER = { zIndex: 0 } as const;
const INPUT_LAYER = { zIndex: 1 } as const;

/**
 * Typography the highlight mirror and the `TextInput` must share so the box lands behind the date
 * phrase. Native TextInputs carry their own font padding, so explicit size/line height/padding
 * (and `includeFontPadding: false` for Android) are pinned on both.
 */
const MIRROR_TEXT = {
  fontSize: Platform.OS === "web" ? 15.5 : 19,
  lineHeight: Platform.OS === "web" ? 22 : 28,
  paddingVertical: Platform.OS === "web" ? 5 : 8,
  includeFontPadding: false,
} as const;

/**
 * The font weight the mirror and the `TextInput` must share: semibold glyphs are wider, so the
 * box drifts left if only the input is semibold.
 */
const MIRROR_WEIGHT = (engaged: boolean) => (engaged ? "font-semibold" : "font-normal");

export interface HighlightSpan {
  start: number;
  end: number;
  boxClass: string;
}

function renderHighlightedSegments(text: string, spans: HighlightSpan[]): ReactNode {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const elements: ReactNode[] = [];
  let cursor = 0;

  for (let i = 0; i < sorted.length; i++) {
    const span = sorted[i]!;
    if (span.start < cursor) {
      continue;
    }
    if (span.start > cursor) {
      elements.push(text.slice(cursor, span.start));
    }
    elements.push(
      <Text key={i} className={"rounded text-transparent " + span.boxClass}>
        {text.slice(span.start, span.end)}
      </Text>,
    );
    cursor = span.end;
  }
  if (cursor < text.length) {
    elements.push(text.slice(cursor));
  }
  return elements;
}

/**
 * Whether `phrase` appears in `value` as a contiguous run of whitespace-delimited words
 * (case-insensitive), like the parser tokenises. Retires stale unlink ignores.
 */
function containsTokenPhrase(value: string, phrase: string): boolean {
  const normPhrase = phrase.toLowerCase().trim();
  if (!normPhrase) return true;
  const normValue = value.toLowerCase().trim();
  const barePhrase = normPhrase.replace(/^[#@]/, "");
  const tokens = normValue.split(/\s+/).map((t) => t.replace(/[.,:;!?]+$/, ""));
  for (const t of tokens) {
    if (t === normPhrase || t === barePhrase || t.replace(/^[#@]/, "") === barePhrase) {
      return true;
    }
  }
  const phraseTokens = normPhrase.split(/\s+/);
  if (phraseTokens.length > 1) {
    outer: for (let i = 0; i + phraseTokens.length <= tokens.length; i++) {
      for (let j = 0; j < phraseTokens.length; j++) {
        if (tokens[i + j] !== phraseTokens[j]) continue outer;
      }
      return true;
    }
  }
  return false;
}

/**
 * Whether the field keeps the caret after Enter, read off `ADD_TASK_SUBMIT` rather than
 * `Platform`. The phone blurs; the browser stays put. react-native-web still reads `blurOnSubmit`.
 */
const KEEPS_FOCUS_AFTER_ADD = ADD_TASK_SUBMIT.submitBehavior !== "blurAndSubmit";

/** Fallback for the due chip when the caller has no list formatter of its own. */
function defaultFormatDue(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export interface QuickAddProps {
  /** Creates the task. May return its id, which the implicit morning reminder attaches to. */
  onAdd: (input: CreateTaskInput) => void | string;
  /** Applied to every task created here (e.g. the Today view sets a due date). */
  defaults?: Partial<CreateTaskInput>;
  resolveProject?: (name: string) => string | null | undefined;
  resolveLabels?: (names: string[]) => string[];
  now?: number;
  timeZone?: string;
  smartDates?: boolean;
  projects?: { id: string; name: string }[];
  sections?: { id: string; project_id: string; name: string }[];
  labels?: { id: string; name: string; color?: string }[];
  onCreateProject?: (name: string) => string;
  onCreateLabel?: (name: string, color?: string) => string;
  labelSuggestions?: string[];
  projectSuggestions?: string[];
  formatDue?: (ms: number) => string;
  autoFocus?: boolean;
  placeholder?: string;
  accessibilityLabel?: string;
  onSubmitted?: () => void;
  onCancel?: () => void;
  onDraftChange?: (hasInput: boolean) => void;
  isModal?: boolean;
}

/**
 * The mention being typed at the end of the draft: a trailing `@partial` or `#partial`. `start` is
 * the sigil's offset. Null when the trailing word is not a mention.
 */
function trailingMention(text: string): { sigil: "@" | "#"; query: string; start: number } | null {
  const m = /(?:^|\s)([@#])([\p{L}\p{N}_-]*)$/u.exec(text);
  if (!m) return null;
  return {
    sigil: m[1] as "@" | "#",
    query: m[2] ?? "",
    start: text.length - (m[2]?.length ?? 0) - 1,
  };
}

/** One row of the mention-suggestion popover: an existing name to pick, or the typed text to create. */
type SuggestionItem =
  { kind: "pick"; name: string } | { kind: "create"; name: string; sigil: "@" | "#" };

export function QuickAdd(props: QuickAddProps) {
  const {
    onAdd,
    defaults,
    resolveProject,
    resolveLabels,
    now,
    timeZone,
    smartDates = true,
    projects = [],
    sections = [],
    labels = [],
    onCreateProject,
    onCreateLabel,
    labelSuggestions = labels.map((l) => l.name),
    projectSuggestions = projects.map((p) => p.name),
    formatDue = defaultFormatDue,
    autoFocus = false,
    placeholder,
    accessibilityLabel,
    onSubmitted,
    onCancel,
    onDraftChange,
    isModal = false,
  } = props;
  const { t, i18n } = useTranslation();
  const effectiveLabel = accessibilityLabel ?? t("quickAdd.label");
  const effectivePlaceholder = placeholder ?? t("quickAdd.placeholder");
  const attachMorningReminder = useQuickAddMorningReminder();
  const [text, setText] = useState("");
  const [notes, setNotes] = useState("");
  const [descHeight, setDescHeight] = useState<number | undefined>(undefined);
  const [draft, setDraft] = useState<ComposeDraft>({});

  const hasInput =
    text.trim().length > 0 || notes.trim().length > 0 || Object.keys(draft).length > 0;

  useEffect(() => {
    onDraftChange?.(hasInput);
  }, [hasInput, onDraftChange]);
  const [engaged, setEngaged] = useState(autoFocus || isModal);
  const [added, setAdded] = useState(0);
  const [ignoredDates, setIgnoredDates] = useState<string[]>([]);
  const [ignoredProjects, setIgnoredProjects] = useState<string[]>([]);
  const [ignoredLabels, setIgnoredLabels] = useState<string[]>([]);
  const selection = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  const inputRef = useRef<TextInputInstance>(null);
  const containerRef = useRef<ViewInstance>(null);
  useQuickAddHotkeyTarget(() => {
    setEngaged(true);
    inputRef.current?.focus();
  });
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const barPress = useRef(false);

  useEffect(() => {
    if (autoFocus || isModal) {
      setEngaged(true);
      const t1 = setTimeout(() => inputRef.current?.focus(), 50);
      const t2 = setTimeout(() => inputRef.current?.focus(), 150);
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
      };
    }
  }, [autoFocus, isModal]);

  const handleFocus = () => {
    if (blurTimer.current) {
      clearTimeout(blurTimer.current);
      blurTimer.current = null;
    }
    setEngaged(true);
  };

  const handleCancel = () => {
    if (onCancel) {
      onCancel();
      return;
    }
    setText("");
    setNotes("");
    setDescHeight(undefined);
    setDraft({});
    setIgnoredDates([]);
    setIgnoredProjects([]);
    setIgnoredLabels([]);
    setEngaged(false);
    inputRef.current?.blur();
  };

  const handleBlur = () => {
    if (barPress.current) {
      barPress.current = false;
      return;
    }
    if (autoFocus || isModal) return;

    if (Platform.OS === "web") {
      if (blurTimer.current) clearTimeout(blurTimer.current);
      blurTimer.current = setTimeout(() => {
        if (typeof document !== "undefined" && containerRef.current) {
          const active = document.activeElement;
          if (active && (containerRef.current as unknown as HTMLElement).contains(active)) {
            return;
          }
        }
        if (text.trim().length > 0 || notes.trim().length > 0) return;
        setEngaged(false);
      }, 75);
      return;
    }

    if (text.trim().length > 0 || notes.trim().length > 0) return;
    setEngaged(false);
  };

  const parsed = useMemo(
    () =>
      parseQuickAdd(text, now ?? Date.now(), {
        projectIdByName: (name: string) => {
          if (resolveProject) {
            const res = resolveProject(name);
            if (res) return res;
          }
          const found = projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
          if (found) return found.id;
          if (draft.project_id) {
            const draftProject = projects.find((p) => p.id === draft.project_id);
            if (draftProject && draftProject.name.toLowerCase() === name.toLowerCase()) {
              return draftProject.id;
            }
          }
          return null;
        },
        isKnownLabel: (name: string) => {
          const q = name.toLowerCase();
          if (resolveLabels) {
            const ids = resolveLabels([name]);
            if (ids.length > 0) return true;
          }
          if (labels.some((l) => l.name.toLowerCase() === q)) return true;
          if (
            draft.label_ids?.some((id) => {
              const l = labels.find((x) => x.id === id);
              return l && l.name.toLowerCase() === q;
            })
          ) {
            return true;
          }
          return false;
        },
        timeZone,
        ignoreDates: ignoredDates,
        ignoreProjects: ignoredProjects,
        ignoreLabels: ignoredLabels,
        disableDates: !smartDates || draft.due_at !== undefined,
        language: i18n.language,
      }),
    [
      text,
      now,
      timeZone,
      resolveProject,
      projects,
      resolveLabels,
      labels,
      ignoredDates,
      ignoredProjects,
      ignoredLabels,
      smartDates,
      draft.due_at,
      draft.project_id,
      draft.label_ids,
      i18n.language,
    ],
  );

  const dm = smartDates ? parsed.dateMatch : null;
  const highlightSpans = useMemo<HighlightSpan[]>(() => {
    const spans: HighlightSpan[] = [];
    if (dm) {
      spans.push({ start: dm.start, end: dm.end, boxClass: chipColors("due").box });
    }
    if (parsed.projectMatch) {
      spans.push({
        start: parsed.projectMatch.start,
        end: parsed.projectMatch.end,
        boxClass: chipColors("project").box,
      });
    }
    if (parsed.labelMatches) {
      for (const lm of parsed.labelMatches) {
        spans.push({ start: lm.start, end: lm.end, boxClass: chipColors("label").box });
      }
    }
    return spans;
  }, [dm, parsed.projectMatch, parsed.labelMatches]);
  const value = useMemo(() => composeValue(defaults, parsed, draft), [defaults, parsed, draft]);

  const mention = trailingMention(text);
  const { suggestions, showCreate } = useMemo(() => {
    if (!mention || mention.query.trim().length === 0) {
      return { suggestions: [], showCreate: false };
    }
    const token = `${mention.sigil}${mention.query}`;
    if (
      (mention.sigil === "#" &&
        (ignoredProjects.includes(token) || ignoredProjects.includes(mention.query))) ||
      (mention.sigil === "@" &&
        (ignoredLabels.includes(token) || ignoredLabels.includes(mention.query)))
    ) {
      return { suggestions: [], showCreate: false };
    }
    const pool = mention.sigil === "@" ? labelSuggestions : projectSuggestions;
    const q = mention.query.toLowerCase();
    // Names may repeat; the popover keys rows by name, so duplicates would collide.
    const matches = [...new Set(pool.filter((name) => name.toLowerCase().includes(q)))].slice(0, 6);
    const exactMatch = pool.some((name) => name.toLowerCase() === q);
    const canCreate = mention.sigil === "@" ? !!onCreateLabel : !!onCreateProject;
    return {
      suggestions: matches,
      showCreate: canCreate && !exactMatch && mention.query.trim().length > 0,
    };
  }, [
    mention,
    labelSuggestions,
    projectSuggestions,
    onCreateLabel,
    onCreateProject,
    ignoredProjects,
    ignoredLabels,
  ]);

  const pickSuggestion = (name: string) => {
    if (!mention) return;
    setText(`${text.slice(0, mention.start)}${mention.sigil}${name} `);
    inputRef.current?.focus();
  };

  // Only a store-backed creator may mint the id: an invented one would point at a project or label that does not exist.
  const handleCreateMention = (sigil: "@" | "#", name: string) => {
    if (sigil === "#") {
      if (!onCreateProject) return;
      const id = onCreateProject(name);
      setDraft((prev) => mergeDraft(prev, { project_id: id }));
      pickSuggestion(name);
    } else {
      if (!onCreateLabel) return;
      const id = onCreateLabel(name);
      setDraft((prev) =>
        mergeDraft(prev, {
          label_ids: [...(prev.label_ids ?? []), id],
        }),
      );
      pickSuggestion(name);
    }
  };

  const suggestionItems = useMemo<SuggestionItem[]>(() => {
    const items: SuggestionItem[] = suggestions.map((name) => ({ kind: "pick", name }));
    if (showCreate && mention) {
      items.push({ kind: "create", name: mention.query, sigil: mention.sigil });
    }
    return items;
  }, [suggestions, showCreate, mention]);

  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const popoverActive = mention != null && !suggestionsDismissed && suggestionItems.length > 0;
  const activeSuggestionIndex = Math.min(suggestionIndex, suggestionItems.length - 1);

  useEffect(() => {
    setSuggestionIndex(0);
    setSuggestionsDismissed(false);
  }, [mention?.sigil, mention?.query]);

  const acceptSuggestion = () => {
    const item = suggestionItems[activeSuggestionIndex];
    if (!item) return;
    if (item.kind === "create") handleCreateMention(item.sigil, item.name);
    else pickSuggestion(item.name);
  };

  const isMentionSelected = (name: string, sigil: "@" | "#") => {
    if (sigil === "#") {
      if (!value.project_id) return false;
      const found = projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (found && found.id === value.project_id) return true;
      if (resolveProject && resolveProject(name) === value.project_id) return true;
      return false;
    } else {
      if (!value.label_ids || value.label_ids.length === 0) return false;
      const found = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
      if (found && value.label_ids.includes(found.id)) return true;
      if (resolveLabels) {
        const resolved = resolveLabels([name]);
        if (resolved.some((id) => value.label_ids.includes(id))) return true;
      }
      return false;
    }
  };

  const submit = () => {
    if (!parsed.title) return;
    const typedLabelIds: string[] = [];
    if (parsed.labels.length > 0) {
      for (const name of parsed.labels) {
        const found = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
        if (found) {
          typedLabelIds.push(found.id);
        } else if (resolveLabels) {
          const resolved = resolveLabels([name]);
          typedLabelIds.push(...resolved);
        }
      }
    }
    const input = composeInput(defaults, parsed, draft, typedLabelIds);

    const parsedProjectChip = parsed.chips.find((c) => c.kind === "project");
    if (!input.project_id && parsedProjectChip) {
      const projName = parsedProjectChip.label.replace(/^#/, "");
      const found = projects.find((p) => p.name.toLowerCase() === projName.toLowerCase());
      if (found) {
        input.project_id = found.id;
      }
    }

    if (notes.trim()) {
      input.notes = notes.trim();
    }

    // Implicit morning-of reminder, quick-add only; needs the created id.
    const createdId = onAdd(input);
    if (typeof createdId === "string") {
      attachMorningReminder(createdId, input.due_at, timeZone, now ?? Date.now());
    }
    haptics.impact("light");
    setText("");
    setNotes("");
    setDescHeight(undefined);
    setDraft({});
    setIgnoredDates([]);
    setIgnoredProjects([]);
    setIgnoredLabels([]);
    setAdded((n) => n + 1);
    if (!KEEPS_FOCUS_AFTER_ADD || (isModal && Platform.OS !== "web")) {
      inputRef.current?.blur();
      setEngaged(false);
    } else {
      setEngaged(true);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
    onSubmitted?.();
  };

  const onKeyPress = (e: TextInputKeyPressEvent) => {
    if (isEscapeKey(e)) {
      // Two-step: close the popover first, so cancelling does not discard the mention being typed.
      if (popoverActive) {
        e.preventDefault();
        setSuggestionsDismissed(true);
        return;
      }
      handleCancel();
      return;
    }
    if (popoverActive && (e.nativeEvent.key === "ArrowDown" || e.nativeEvent.key === "ArrowUp")) {
      e.preventDefault();
      const count = suggestionItems.length;
      if (count > 0) {
        const current = Math.min(activeSuggestionIndex, count - 1);
        const delta = e.nativeEvent.key === "ArrowDown" ? 1 : -1;
        setSuggestionIndex((current + delta + count) % count);
      }
      return;
    }
    if (Platform.OS !== "web" || e.nativeEvent.key !== "Backspace") return;
    const sel = selection.current;
    if (sel.start !== sel.end) return;

    if (parsed.projectMatch && sel.start === parsed.projectMatch.end) {
      e.preventDefault();
      const pText = parsed.projectMatch.text;
      setIgnoredProjects((prev) => (prev.includes(pText) ? prev : [...prev, pText]));
      setDraft((prev) => {
        if (prev.project_id === undefined) return prev;
        const next = { ...prev };
        delete next.project_id;
        return next;
      });
      setSuggestionsDismissed(true);
      return;
    }

    if (parsed.labelMatches) {
      const lm = parsed.labelMatches.find((m) => m.end === sel.start);
      if (lm) {
        e.preventDefault();
        setIgnoredLabels((prev) => (prev.includes(lm.text) ? prev : [...prev, lm.text]));
        setDraft((prev) => {
          if (!prev.label_ids) return prev;
          const found = labels.find((l) => l.name.toLowerCase() === lm.value.toLowerCase());
          if (!found) return prev;
          return {
            ...prev,
            label_ids: prev.label_ids.filter((id) => id !== found.id),
          };
        });
        setSuggestionsDismissed(true);
        return;
      }
    }

    const dm = parsed.dateMatch;
    if (dm && sel.start === dm.end) {
      e.preventDefault();
      setIgnoredDates((prev) => (prev.includes(dm.text) ? prev : [...prev, dm.text]));
    }
  };

  const onNotesKeyPress = (e: TextInputKeyPressEvent) => {
    if (isEscapeKey(e)) {
      handleCancel();
      return;
    }
    if (Platform.OS === "web") {
      const native = e.nativeEvent as {
        key: string;
        metaKey?: boolean;
        ctrlKey?: boolean;
        preventDefault?: () => void;
      };
      if (native.key === "Enter" && (native.metaKey || native.ctrlKey)) {
        native.preventDefault?.();
        submit();
      }
    }
  };

  const onSelectionChange = (e: TextInputSelectionChangeEvent) => {
    selection.current = e.nativeEvent.selection;
  };

  const clearDue = () => {
    if (dm && draft.due_at === undefined) setIgnoredDates((prev) => [...prev, dm.text]);
    else setDraft((prev) => mergeDraft(prev, { due_at: null }));
  };

  const isWeb = Platform.OS === "web";
  const canSubmit =
    text.trim().length > 0 || (parsed.title != null && parsed.title.trim().length > 0);

  return (
    <View
      ref={containerRef}
      className={
        "w-full " +
        (isModal
          ? ""
          : engaged
            ? "max-w-2xl rounded-2xl border border-slate-200 bg-white p-3.5 shadow-xl dark:border-slate-800 dark:bg-zinc-900 my-2"
            : "max-w-2xl px-1 py-1 my-0.5 shadow-none")
      }
    >
      <View
        className={
          engaged
            ? "w-full"
            : "flex-row items-center gap-2.5 rounded-xl px-2.5 py-2 web:hover:bg-neutral-100/70 dark:web:hover:bg-neutral-800/40 web:cursor-pointer web:transition-colors"
        }
      >
        <View className={engaged ? "relative w-full" : "flex-1 flex-row items-center gap-2.5"}>
          {!engaged && (
            <Pressable
              onPress={() => {
                setEngaged(true);
                inputRef.current?.focus();
              }}
              hitSlop={6}
              accessible={false}
              importantForAccessibility="no"
            >
              <Plus
                size={isWeb ? 16 : 18}
                className="text-neutral-500 dark:text-neutral-400 shrink-0"
              />
            </Pressable>
          )}

          <View className={engaged ? "relative w-full" : "relative flex-1"}>
            {/* Highlight overlay behind the input */}
            <View
              style={{ pointerEvents: "none", ...HIGHLIGHT_LAYER }}
              className="absolute inset-0 overflow-hidden"
            >
              <Text
                numberOfLines={1}
                style={MIRROR_TEXT}
                className={"text-transparent " + MIRROR_WEIGHT(engaged)}
              >
                {renderHighlightedSegments(text, highlightSpans)}
              </Text>
            </View>
            <TextInput
              ref={inputRef}
              autoFocus={autoFocus}
              accessibilityLabel={effectiveLabel}
              placeholder={effectivePlaceholder}
              placeholderTextColor="#64748b"
              value={text}
              onChangeText={(v) => {
                if (Platform.OS !== "web" && v.length === text.length - 1) {
                  if (
                    parsed.projectMatch &&
                    text.slice(0, parsed.projectMatch.end - 1) +
                      text.slice(parsed.projectMatch.end) ===
                      v
                  ) {
                    inputRef.current?.setNativeProps({ text });
                    const pText = parsed.projectMatch.text;
                    setIgnoredProjects((prev) => (prev.includes(pText) ? prev : [...prev, pText]));
                    setDraft((prev) => {
                      if (prev.project_id === undefined) return prev;
                      const next = { ...prev };
                      delete next.project_id;
                      return next;
                    });
                    return;
                  }
                  if (parsed.labelMatches) {
                    const lm = parsed.labelMatches.find(
                      (m) => text.slice(0, m.end - 1) + text.slice(m.end) === v,
                    );
                    if (lm) {
                      inputRef.current?.setNativeProps({ text });
                      setIgnoredLabels((prev) =>
                        prev.includes(lm.text) ? prev : [...prev, lm.text],
                      );
                      setDraft((prev) => {
                        if (!prev.label_ids) return prev;
                        const found = labels.find(
                          (l) => l.name.toLowerCase() === lm.value.toLowerCase(),
                        );
                        if (!found) return prev;
                        return {
                          ...prev,
                          label_ids: prev.label_ids.filter((id) => id !== found.id),
                        };
                      });
                      return;
                    }
                  }
                  if (dm && text.slice(0, dm.end - 1) + text.slice(dm.end) === v) {
                    inputRef.current?.setNativeProps({ text });
                    setIgnoredDates((prev) => (prev.includes(dm.text) ? prev : [...prev, dm.text]));
                    return;
                  }
                }
                setText(v);
                if (v.trim().length > 0) setEngaged(true);
                // Forget an ignored phrase once it leaves the text, so retyping re-links the box.
                setIgnoredDates((prev) =>
                  prev.length === 0 ? prev : prev.filter((p) => containsTokenPhrase(v, p)),
                );
                setIgnoredProjects((prev) =>
                  prev.length === 0 ? prev : prev.filter((p) => containsTokenPhrase(v, p)),
                );
                setIgnoredLabels((prev) =>
                  prev.length === 0 ? prev : prev.filter((p) => containsTokenPhrase(v, p)),
                );
              }}
              onKeyPress={onKeyPress}
              onSelectionChange={onSelectionChange}
              onFocus={handleFocus}
              onBlur={handleBlur}
              // Enter accepts the highlighted row while the popover is open. Web only: on the phone
              // Enter blurs, so picking would close the keyboard mid-mention.
              onSubmitEditing={isWeb && popoverActive ? acceptSuggestion : submit}
              {...ADD_TASK_SUBMIT}
              returnKeyType="done"
              style={[INPUT_LAYER, MIRROR_TEXT, { paddingHorizontal: 0 }]}
              className={
                "relative w-full border-none bg-transparent focus:outline-none text-base " +
                MIRROR_WEIGHT(engaged) +
                " " +
                (engaged
                  ? "text-neutral-900 dark:text-white"
                  : "text-neutral-800 placeholder:text-neutral-500 dark:text-white dark:placeholder:text-neutral-500")
              }
            />
          </View>
        </View>

        {engaged && (
          <View className="mt-2 w-full">
            <TextInput
              accessibilityLabel={t("quickAdd.description") ?? "Description"}
              placeholder={t("quickAdd.descriptionPlaceholder") ?? "Description..."}
              placeholderTextColor="#64748b"
              value={notes}
              onChangeText={(v) => {
                setNotes(v);
                if (v === "") setDescHeight(undefined);
              }}
              onKeyPress={onNotesKeyPress}
              onFocus={handleFocus}
              onBlur={handleBlur}
              multiline
              onContentSizeChange={(e) => {
                const h = e.nativeEvent.contentSize.height;
                if (notes.length > 0) {
                  setDescHeight(Math.max(28, Math.min(160, h)));
                }
              }}
              style={[
                {
                  paddingHorizontal: 0,
                  paddingVertical: 2,
                  height: descHeight ?? 28,
                  textAlignVertical: "top",
                },
                isWeb ? ({ outline: "none", resize: "none" } as object) : undefined,
              ]}
              className="w-full border-none bg-transparent text-sm text-neutral-700 placeholder:text-neutral-500 focus:outline-none dark:text-neutral-300 dark:placeholder:text-neutral-500"
            />
          </View>
        )}
      </View>

      {/* Mention Suggestions Popover: arrows move the highlight, Enter accepts it (web), tap always works */}
      {popoverActive && mention && (
        <View
          accessibilityLabel={t("quickAdd.suggestions")}
          className="my-2 self-start overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-zinc-900"
        >
          {suggestions.map((name, i) => {
            const isHighlighted = i === activeSuggestionIndex;
            const isSelected = isMentionSelected(name, mention.sigil);
            return (
              <Pressable
                key={name}
                accessibilityRole="button"
                accessibilityLabel={name}
                accessibilityState={isHighlighted || isSelected ? { selected: true } : undefined}
                onPress={() => pickSuggestion(name)}
                className={
                  "flex-row items-center gap-2 border-l-2 min-h-[40px] py-2 pr-3.5 pl-3 transition-colors web:cursor-pointer " +
                  (isHighlighted
                    ? "border-accent-600 bg-accent-50 dark:border-accent-400 dark:bg-accent-900"
                    : "border-transparent active:bg-slate-100 dark:active:bg-slate-800 web:hover:bg-slate-100 dark:web:hover:bg-slate-800")
                }
              >
                {mention.sigil === "@" ? (
                  <Tag
                    size={14}
                    className={
                      isHighlighted
                        ? "text-accent-600 dark:text-accent-400"
                        : "text-slate-400 dark:text-slate-500"
                    }
                  />
                ) : (
                  <Hash
                    size={14}
                    className={
                      isHighlighted
                        ? "text-accent-600 dark:text-accent-400"
                        : "text-slate-400 dark:text-slate-500"
                    }
                  />
                )}
                <Text
                  className={
                    "flex-1 text-sm " +
                    (isHighlighted
                      ? "font-semibold text-accent-950 dark:text-accent-200"
                      : isSelected
                        ? "font-medium text-accent-700 dark:text-accent-300"
                        : "font-medium text-slate-800 dark:text-slate-200")
                  }
                >
                  {name}
                </Text>
                {isSelected && (
                  <Check
                    size={14}
                    className="ml-auto shrink-0 text-accent-600 dark:text-accent-400"
                  />
                )}
              </Pressable>
            );
          })}

          {showCreate && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${t("common.create", "Create")} ${mention.sigil}${mention.query}`}
              accessibilityState={
                activeSuggestionIndex === suggestions.length ? { selected: true } : undefined
              }
              onPress={() => handleCreateMention(mention.sigil, mention.query)}
              className={
                "flex-row items-center gap-2 border-t border-l-2 border-slate-100 min-h-[40px] py-2 pr-3.5 pl-3 transition-colors dark:border-slate-800/60 web:cursor-pointer " +
                (activeSuggestionIndex === suggestions.length
                  ? "border-l-accent-600 bg-accent-50 dark:border-l-accent-400 dark:bg-accent-900"
                  : "border-l-transparent bg-transparent active:bg-slate-100 dark:active:bg-slate-800 web:hover:bg-slate-100 dark:web:hover:bg-slate-800")
              }
            >
              <Plus
                size={14}
                className={
                  activeSuggestionIndex === suggestions.length
                    ? "text-accent-600 dark:text-accent-400"
                    : "text-slate-400 dark:text-slate-500"
                }
              />
              <Text
                className={
                  "text-sm " +
                  (activeSuggestionIndex === suggestions.length
                    ? "font-semibold text-accent-950 dark:text-accent-200"
                    : "font-medium text-slate-700 dark:text-slate-300")
                }
              >
                {t("common.create", "Create")} {mention.sigil}
                <Text
                  className={
                    activeSuggestionIndex === suggestions.length
                      ? "font-bold text-accent-950 dark:text-accent-100"
                      : "font-semibold text-slate-900 dark:text-slate-100"
                  }
                >
                  {mention.query}
                </Text>
              </Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Separating line and bottom toolbar dock */}
      {engaged && (
        <>
          {/* Line separating text inputs from bottom actions */}
          <View className="my-2 h-[1px] w-full bg-slate-200 dark:bg-slate-800" />

          {/* Bottom Toolbar: Chips on left, larger Send button and Cancel below it on right */}
          <View
            className="w-full flex-row items-center justify-between gap-2"
            onStartShouldSetResponderCapture={() => {
              barPress.current = true;
              return false;
            }}
          >
            <View className="flex-1 min-w-0">
              <TaskComposeBar
                key={added}
                value={value}
                onChange={(patch) => setDraft((prev) => mergeDraft(prev, patch))}
                projects={projects}
                sections={sections}
                labels={labels}
                onCreateProject={onCreateProject}
                onCreateLabel={onCreateLabel}
                now={now ?? Date.now()}
                timeZone={timeZone}
                formatDue={formatDue}
                onClearDue={clearDue}
                onInteract={() => inputRef.current?.focus()}
              />
            </View>

            {/* Right-hand side action: Prominent Send button */}
            <View className="items-center justify-center shrink-0">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("common.add")}
                onPress={submit}
                hitSlop={8}
                className={
                  (isWeb ? "h-9 w-9 sm:h-9 sm:w-9 " : "h-12 w-12 ") +
                  "items-center justify-center rounded-full web:transition-all " +
                  (canSubmit
                    ? "bg-accent-600 active:scale-95 web:cursor-pointer"
                    : "bg-slate-200 dark:bg-slate-800 opacity-60 shadow-none")
                }
              >
                <ArrowUp
                  size={isWeb ? 16 : 28}
                  strokeWidth={isWeb ? 2 : 2.5}
                  className={canSubmit ? "text-white" : "text-slate-400 dark:text-slate-500"}
                />
              </Pressable>
            </View>
          </View>
        </>
      )}
    </View>
  );
}
