import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Activity, Comment } from "@atlastodo/shared";
import type { Task } from "@atlastodo/client-core";
import { useAuth } from "../auth/AuthContext";
import { useComments } from "../hooks/useComments";
import { useActivities } from "../hooks/useActivities";
import { useProjectMembers } from "../hooks/useProjectMembers";
import { useFormat } from "../hooks/useFormat";
import { useToast } from "../data/ToastProvider";
import { MessageSquare, Send, Trash2 } from "./icons";
import { KEEP_FOCUS_SUBMIT } from "../lib/submitBehavior";
import { useCancelOnEscape } from "../hooks/useCancelOnEscape";

/**
 * Task discussion: a time-ordered feed of comments and activity entries, plus a box to add a
 * comment. Activity entries are written by `useLocalTasks` (`writeActivity`). Roles are enforced
 * server-side, so the client writes optimistically. Names resolve to "You", a collaborator's name
 * via `useProjectMembers`, or "Someone" off a shared project.
 */

type FeedItem =
  { type: "comment"; at: number; data: Comment } | { type: "activity"; at: number; data: Activity };

export function CommentSection({ task }: { task: Task }) {
  const { t } = useTranslation();
  const { session } = useAuth();
  const myId = session?.user.id;
  const { forTask: commentsForTask, addComment, removeComment } = useComments();
  const { forTask: activityForTask } = useActivities();
  const { byUserId } = useProjectMembers();
  const fmt = useFormat();
  const toast = useToast();
  const [draft, setDraft] = useState("");

  const comments = commentsForTask(task.id);
  const activities = activityForTask(task.id);

  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [
      ...comments.map((c) => ({ type: "comment" as const, at: c.created_at, data: c })),
      ...activities.map((a) => ({ type: "activity" as const, at: a.created_at, data: a })),
    ];
    return items.sort((x, y) => x.at - y.at);
  }, [comments, activities]);

  const nameOf = (userId: string | null): string => {
    if (userId && userId === myId) return t("comment.you");
    const m = userId ? byUserId(userId) : undefined;
    return m?.display_name || m?.email || t("comment.someone");
  };

  const describe = (a: Activity): string => {
    switch (a.kind) {
      case "status":
        return a.to === "completed" ? t("comment.completedTask") : t("comment.reopenedTask");
      case "due":
        return a.to
          ? t("comment.setDueDate", { date: fmt.dueChip(Number(a.to)) })
          : t("comment.clearedDueDate");
      case "assignee":
        return a.to
          ? t("comment.assignedThis", { name: nameOf(a.to) })
          : t("comment.unassignedThis");
    }
  };

  const submit = () => {
    const body = draft.trim();
    if (!body || !myId) return;
    addComment(task.id, myId, body);
    setDraft("");
  };
  const escapeDraft = useCancelOnEscape(() => setDraft(""));

  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <MessageSquare size={16} className="text-neutral-500" />
        <Text className="text-xs font-medium text-neutral-500">{t("comment.activity")}</Text>
      </View>

      {feed.length === 0 && (
        <Text className="text-xs text-neutral-500">{t("comment.noActivity")}</Text>
      )}

      {feed.map((item) =>
        item.type === "comment" ? (
          <View key={`c-${item.data.id}`} className="gap-0.5">
            <View className="flex-row items-center gap-2">
              <Text className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                {nameOf(item.data.author_id)}
              </Text>
              <Text className="text-xs text-neutral-500">{fmt.dateTime(item.data.created_at)}</Text>
              {item.data.author_id === myId && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("comment.delete")}
                  onPress={() => {
                    const undo = removeComment(item.data.id);
                    toast.show(t("toast.commentDeleted"), { label: t("common.undo"), run: undo });
                  }}
                  hitSlop={8}
                >
                  <Trash2 size={14} className="text-neutral-500" />
                </Pressable>
              )}
            </View>
            <Text className="text-sm text-neutral-700 dark:text-neutral-200">{item.data.body}</Text>
          </View>
        ) : (
          <View key={`a-${item.data.id}`} className="flex-row flex-wrap items-baseline gap-1">
            <Text className="text-xs text-neutral-500">
              {nameOf(item.data.actor_id)} {describe(item.data)}
            </Text>
            <Text className="text-xs text-neutral-500">{fmt.dateTime(item.data.created_at)}</Text>
          </View>
        ),
      )}

      <View className="flex-row items-center gap-2">
        <TextInput
          ref={escapeDraft.ref}
          accessibilityLabel={t("comment.add")}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={submit}
          onKeyPress={escapeDraft.onKeyPress}
          placeholder={t("comment.write")}
          placeholderTextColor="#737373"
          {...KEEP_FOCUS_SUBMIT}
          className="flex-1 rounded-lg border border-neutral-200 px-3.5 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("comment.post")}
          onPress={submit}
          disabled={draft.trim() === ""}
          className={"rounded-lg p-2 " + (draft.trim() === "" ? "opacity-40" : "")}
        >
          <Send size={16} className="text-accent-600" />
        </Pressable>
      </View>
    </View>
  );
}
