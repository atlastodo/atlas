import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  ApiError,
  apiErrorCode,
  forgetIdentity,
  generatePek,
  isProjectShared,
  isVerified,
  observeIdentity,
  performKeyRotations,
  pinMemberKey,
  pinnedMemberKey,
  projectKeyId,
  readKeyTrust,
  recordMintedKey,
  recordVerified,
  rescopeProject,
  safetyNumber,
  safetyNumberGroups,
  sealDelivery,
  unpinMemberKey,
  wrapProjectKey,
  type IdentityObservation,
  type MemberRole,
  type MemberView,
} from "@atlastodo/client-core";
import { useAuth } from "../auth/AuthContext";
import { useStore } from "../data/StoreProvider";
import {
  loadProjectKeys,
  memberKeyChanges,
  onMemberKeyChanges,
  requestProjectKeyMaintenance,
} from "../hooks/useProjectKeyMaintenance";
import { BottomSheet } from "./BottomSheet";
import { Segmented } from "./Segmented";
import { SkeletonRows } from "./Skeleton";
import { RefreshCw, ShieldCheck, Trash2, UserPlus } from "./icons";
import {
  DISABLED_BUTTON_CLASS,
  DISABLED_BUTTON_TEXT_CLASS,
  PLACEHOLDER_COLOR,
} from "./useSheetDismiss";

/**
 * Manage a project's collaborators: invite by email, change roles, remove members. Membership is
 * server-authoritative and REST-driven; a successful change `kick()`s a sync. Sharing is E2EE:
 * the invite goes first, then the project key is sealed to each invitee's pinned public key and
 * signed with the user's identity key. Each member gets a safety number to verify out of band;
 * removing a member rotates the project key. See docs/architecture.md.
 */

const ROLE_KEY: Record<MemberRole, string> = {
  owner: "share.owner",
  editor: "share.editor",
  commenter: "share.commenter",
};

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A failure with a translatable explanation. */
class ShareError extends Error {
  constructor(
    readonly key: string,
    readonly params: Record<string, string> = {},
  ) {
    super(key);
    this.name = "ShareError";
  }
}

export function ShareDialog({
  projectId,
  projectName,
  onClose,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { api, session, keyring } = useAuth();
  const { store, kick } = useStore();
  const [members, setMembers] = useState<MemberView[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("editor");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());
  const [keyChanges, setKeyChanges] = useState(() => new Set(memberKeyChanges()));
  useEffect(() => onMemberKeyChanges(() => setKeyChanges(new Set(memberKeyChanges()))), []);
  const [identities, setIdentities] = useState<ReadonlyMap<string, IdentityObservation>>(
    () => new Map(),
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [trustVersion, setTrustVersion] = useState(0);
  const myId = session?.user.id;
  const viewerIsOwner = members.some(
    (m) => m.user_id === myId && m.role === "owner" && m.state === "active",
  );

  useEffect(() => {
    const next = new Map<string, IdentityObservation>();
    for (const m of members) {
      if (m.user_id === myId) continue;
      next.set(
        m.user_id,
        observeIdentity(store, readKeyTrust(store), m.user_id, {
          publicKey: m.public_key,
          signingKey: m.signing_public_key,
        }),
      );
    }
    setIdentities(next);
  }, [members, myId, store]);

  /** The safety number with `userId`, from both sides' pinned keys; null while a key is missing. */
  const safetyNumberWith = (userId: string): string | null => {
    const theirs = identities.get(userId);
    const myPublic = keyring?.getUserPublicKey() ?? session?.publicKey;
    const mySigning = keyring?.getSigningPublicKey();
    if (!myId || !myPublic || !mySigning) return null;
    if (theirs?.status !== "trusted" || !theirs.pinned?.signingKey) return null;
    return safetyNumber(
      { userId: myId, publicKey: myPublic, signingKey: mySigning },
      { userId, publicKey: theirs.pinned.publicKey, signingKey: theirs.pinned.signingKey },
    );
  };
  // Computed only for the member whose number is open: the derivation is slow.
  const openNumber = useMemo(
    () => (expanded ? safetyNumberWith(expanded) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expanded, identities, keyring, myId],
  );
  const trust = useMemo(
    () => readKeyTrust(store),
    // `trustVersion` bumps when this dialog records a verification.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, trustVersion, identities],
  );
  const setVerified = (userId: string, number: string | null) => {
    recordVerified(store, userId, number);
    setTrustVersion((v) => v + 1);
    kick();
  };

  const describe = (err: unknown, fallback: string): string => {
    if (err instanceof ShareError) return t(err.key, err.params);
    if (apiErrorCode(err) === "already_member") return t("share.alreadyMember");
    if (err instanceof ApiError && err.message) return err.message;
    return t(fallback);
  };

  const refresh = useCallback(async () => {
    try {
      setMembers(await api.listMembers(projectId));
    } catch (err) {
      setError(err instanceof ApiError && err.message ? err.message : t("invites.membersFailed"));
    } finally {
      setLoadingMembers(false);
    }
  }, [api, projectId, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    requestProjectKeyMaintenance();
  }, []);

  /** The project's canonical key. Only a project that is not shared yet may mint a new one; a second key would split the members. */
  const canonicalKey = async (mayMint: boolean): Promise<{ pek: Uint8Array; keyId: string }> => {
    if (!keyring?.hasKeys()) throw new ShareError("invites.keyUnavailable");
    const held = () => {
      const pek = keyring.getProjectKey(projectId);
      return pek ? { pek, keyId: keyring.canonicalKeyId(projectId)! } : null;
    };
    const first = held();
    if (first) return first;
    if (await loadProjectKeys(api, keyring, store, myId)) kick();
    const loaded = held();
    if (loaded) return loaded;
    if (!mayMint || isProjectShared(store, projectId)) {
      throw new ShareError("invites.keyUnavailable");
    }
    // An unshared project whose earlier attempt minted a key: reuse it. Any other key came from the server.
    const mintedId = readKeyTrust(store).minted.get(projectId);
    const stored = mintedId ? keyring.projectKey(projectId, mintedId) : undefined;
    if (mintedId && stored) {
      keyring.setCanonical(projectId, mintedId);
      return { pek: stored, keyId: mintedId };
    }
    const pek = generatePek();
    const keyId = projectKeyId(pek);
    // Stored before the keyring adopts it: keys live only in memory, so content under an unreceived key would be lost on restart.
    await api.putProjectKey(projectId, wrapProjectKey(pek, keyring.getDek(), projectId), keyId);
    recordMintedKey(store, projectId, keyId);
    keyring.setProjectKey(projectId, pek);
    return { pek, keyId };
  };

  type PublishedKeys = { publicKey: string | null; signingKey: string | null };

  const lookUpPublicKey = async (addr: string): Promise<PublishedKeys> => {
    try {
      const found = await api.getUserPublicKey(addr);
      return { publicKey: found.public_key, signingKey: found.signing_public_key ?? null };
    } catch (err) {
      throw new ShareError("invites.keySendFailed", { email: addr, reason: reasonOf(err) });
    }
  };

  /** Seal the project key to a member's public key, sign it and store it. Later, different keys are refused. */
  const deliverKey = async (
    member: { user_id: string; email: string },
    published: PublishedKeys,
    key: { pek: Uint8Array; keyId: string },
  ) => {
    const { publicKey } = published;
    if (!publicKey) throw new ShareError("invites.noPublicKey", { email: member.email });
    const trustNow = readKeyTrust(store);
    const identity = observeIdentity(store, trustNow, member.user_id, published);
    const pinned = pinnedMemberKey(trustNow, projectId, member.user_id);
    if (identity.status === "changed" || (pinned && pinned !== publicKey)) {
      throw new ShareError("invites.keyChanged", { email: member.email });
    }
    const signingKey = keyring?.getSigningKey();
    if (!signingKey) throw new ShareError("invites.signingKeyMissing");
    if (!pinned) pinMemberKey(store, projectId, member.user_id, publicKey);
    const { sealed, signature } = sealDelivery(key.pek, {
      projectId,
      recipientId: member.user_id,
      recipientPublicKey: publicKey,
      keyId: key.keyId,
      signingKey,
    });
    try {
      await api.putMemberProjectKey(projectId, member.user_id, sealed, key.keyId, signature);
    } catch (err) {
      throw new ShareError("invites.keySendFailed", { email: member.email, reason: reasonOf(err) });
    }
  };

  const invite = async () => {
    const addr = email.trim();
    if (!addr) return;
    setBusy(true);
    setError(null);
    try {
      const found = await api.getUserPublicKey(addr);
      const published = {
        publicKey: found.public_key,
        signingKey: found.signing_public_key ?? null,
      };
      const firstShare = !isProjectShared(store, projectId);
      const key = await canonicalKey(firstShare);
      // Existing content was written under the personal key; re-write it under the project key first.
      if (firstShare) rescopeProject(store, keyring, projectId);
      const member = await api.inviteMember(projectId, addr, role);
      setEmail("");
      try {
        await deliverKey({ user_id: member.user_id, email: member.email || addr }, published, key);
      } catch (err) {
        setError(describe(err, "invites.keyRetryFailed"));
      }
      await refresh();
      kick();
    } catch (err) {
      setError(describe(err, "share.failed"));
    } finally {
      setBusy(false);
    }
  };

  const retryKey = async (member: MemberView) => {
    setRetrying((prev) => new Set(prev).add(member.user_id));
    setError(null);
    try {
      const key = await canonicalKey(false);
      await deliverKey(member, await lookUpPublicKey(member.email), key);
      await refresh();
    } catch (err) {
      setError(describe(err, "invites.keyRetryFailed"));
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(member.user_id);
        return next;
      });
    }
  };

  const changeRole = async (userId: string, next: MemberRole) => {
    setError(null);
    try {
      await api.updateMemberRole(projectId, userId, next);
      await refresh();
      kick();
    } catch (err) {
      setError(describe(err, "invites.memberUpdateFailed"));
    }
  };
  const remove = async (userId: string) => {
    setError(null);
    try {
      await api.removeMember(projectId, userId);
      unpinMemberKey(store, projectId, userId);
      // Removing a member whose keys changed is how the user accepts the new ones; a new invite pins afresh.
      if (identities.get(userId)?.status === "changed") forgetIdentity(store, userId);
      await refresh();
      kick();
    } catch (err) {
      setError(describe(err, "invites.memberUpdateFailed"));
      return;
    }
    if (keyring?.hasKeys() && myId) {
      try {
        const { rotated } = await performKeyRotations(api, keyring, store, myId, {
          projectId,
          removed: [userId],
        });
        if (rotated.length > 0) kick();
      } catch (err) {
        console.warn("[atlas-e2ee] could not rotate the project key after a removal:", err);
      }
    }
  };

  const inviteDisabled = busy || email.trim() === "";
  const roleOptions: { value: MemberRole; label: string }[] = [
    { value: "editor", label: t("share.editor") },
    { value: "commenter", label: t("share.commenter") },
  ];

  return (
    <BottomSheet visible onClose={onClose} title={t("share.title", { name: projectName })}>
      <View className="gap-4">
        <View className="gap-2">
          <TextInput
            accessibilityLabel={t("share.inviteByEmail")}
            value={email}
            onChangeText={setEmail}
            placeholder={t("share.emailPlaceholder")}
            placeholderTextColor={PLACEHOLDER_COLOR}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            className="rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100"
          />
          <View className="flex-row items-center gap-2">
            <Segmented
              value={role}
              options={roleOptions}
              onChange={setRole}
              label={t("share.inviteRole")}
            />
            <View className="flex-1" />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("share.sendInvite")}
              accessibilityState={{ disabled: inviteDisabled }}
              disabled={inviteDisabled}
              onPress={() => void invite()}
              className={
                "flex-row items-center gap-1.5 rounded-md px-3 py-2 " +
                (inviteDisabled ? DISABLED_BUTTON_CLASS : "bg-accent-600 web:cursor-pointer")
              }
            >
              <UserPlus
                size={16}
                className={inviteDisabled ? DISABLED_BUTTON_TEXT_CLASS : "text-white"}
              />
              <Text
                className={
                  "text-sm " + (inviteDisabled ? DISABLED_BUTTON_TEXT_CLASS : "text-white")
                }
              >
                {t("share.sendInvite")}
              </Text>
            </Pressable>
          </View>
          {error != null && (
            <Text accessibilityRole="alert" className="text-xs text-red-500">
              {error}
            </Text>
          )}
        </View>

        <View className="gap-2">
          {loadingMembers && members.length === 0 && <SkeletonRows count={2} />}
          {members.map((m) => {
            const keyPending = viewerIsOwner && m.user_id !== myId && m.has_key === false;
            const isRetrying = retrying.has(m.user_id);
            const name = m.display_name || m.email;
            const identity = identities.get(m.user_id);
            const keysChanged = identity?.status === "changed";
            const isOpen = expanded === m.user_id;
            const number = isOpen ? openNumber : null;
            const verified =
              !keysChanged && isOpen
                ? number !== null && isVerified(trust, m.user_id, number)
                : !keysChanged && trust.verified.has(m.user_id) && identity?.status === "trusted";
            return (
              <View key={m.user_id} className="gap-1">
                <View className="flex-row items-center gap-2">
                  <View className="min-w-0 flex-1">
                    <Text className="text-sm text-neutral-900 dark:text-neutral-100">
                      {name}
                      {m.state === "pending" ? ` ${t("share.pending")}` : ""}
                    </Text>
                    {verified && !isOpen && (
                      <View
                        className="flex-row items-center gap-1"
                        accessible
                        accessibilityLabel={t("share.verifiedFor", { email: m.email })}
                      >
                        <ShieldCheck size={12} className="text-emerald-600 dark:text-emerald-400" />
                        <Text className="text-xs text-emerald-600 dark:text-emerald-400">
                          {t("share.verified")}
                        </Text>
                      </View>
                    )}
                    {keysChanged && (
                      <Text
                        accessibilityRole="alert"
                        className="text-xs text-red-600 dark:text-red-400"
                      >
                        {t("share.keysChanged", { name })}
                        {viewerIsOwner && m.role !== "owner"
                          ? ` ${t("invites.keysChangedRemove", { email: m.email })}`
                          : ""}
                      </Text>
                    )}
                    {keyPending && (
                      <Text className="text-xs text-amber-600 dark:text-amber-400">
                        {keyChanges.has(`${projectId}:${m.user_id}`)
                          ? t("invites.keyChangedBadge")
                          : t("invites.keyPending")}
                      </Text>
                    )}
                  </View>
                  {m.user_id !== myId && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t(
                        isOpen ? "share.hideSafetyNumber" : "share.showSafetyNumber",
                        {
                          email: m.email,
                        },
                      )}
                      accessibilityState={{ expanded: isOpen }}
                      onPress={() => setExpanded(isOpen ? null : m.user_id)}
                      hitSlop={8}
                    >
                      <ShieldCheck
                        size={16}
                        className={
                          verified ? "text-emerald-600 dark:text-emerald-400" : "text-neutral-500"
                        }
                      />
                    </Pressable>
                  )}
                  {keyPending && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("invites.retryKey", { email: m.email })}
                      accessibilityState={{ disabled: isRetrying }}
                      disabled={isRetrying}
                      onPress={() => void retryKey(m)}
                      hitSlop={8}
                      className={`flex-row items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 dark:border-neutral-700 ${
                        isRetrying ? "opacity-50" : ""
                      }`}
                    >
                      <RefreshCw size={12} className="text-neutral-600 dark:text-neutral-300" />
                      <Text className="text-xs text-neutral-600 dark:text-neutral-300">
                        {t("common.retry")}
                      </Text>
                    </Pressable>
                  )}
                  {m.role === "owner" ? (
                    <Text className="text-xs text-neutral-500">{t(ROLE_KEY.owner)}</Text>
                  ) : (
                    <Segmented
                      value={m.role}
                      options={roleOptions}
                      onChange={(next) => void changeRole(m.user_id, next)}
                      label={t("share.roleFor", { email: m.email })}
                    />
                  )}
                  {m.user_id !== myId && m.role !== "owner" && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("share.remove", { email: m.email })}
                      onPress={() => void remove(m.user_id)}
                      hitSlop={8}
                    >
                      <Trash2 size={16} className="text-neutral-500" />
                    </Pressable>
                  )}
                </View>
                {isOpen && (
                  <SafetyNumberPanel
                    name={name}
                    email={m.email}
                    number={keysChanged ? null : number}
                    verified={verified}
                    onVerify={(next) => setVerified(m.user_id, next ? number : null)}
                  />
                )}
              </View>
            );
          })}
        </View>
      </View>
    </BottomSheet>
  );
}

/** A member's safety number (12 groups of 5 digits) with the control that records the user compared it. Without a number it says why. */
function SafetyNumberPanel({
  name,
  email,
  number,
  verified,
  onVerify,
}: {
  name: string;
  email: string;
  number: string | null;
  verified: boolean;
  onVerify: (verified: boolean) => void;
}) {
  const { t } = useTranslation();
  if (number === null) {
    return (
      <Text className="text-xs text-neutral-500">
        {t("share.safetyNumberUnavailable", { name })}
      </Text>
    );
  }
  const groups = safetyNumberGroups(number);
  return (
    <View className="gap-2 rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
      <Text className="text-xs font-semibold text-neutral-700 dark:text-neutral-200">
        {t("share.safetyNumber")}
      </Text>
      <View
        accessible
        accessibilityLabel={`${t("share.safetyNumber")}: ${groups.join(", ")}`}
        className="flex-row flex-wrap gap-x-3 gap-y-1"
      >
        {groups.map((group, i) => (
          <Text
            key={i}
            className="font-mono text-sm tracking-wider text-neutral-900 dark:text-neutral-100"
          >
            {group}
          </Text>
        ))}
      </View>
      <Text className="text-xs text-neutral-500">{t("share.safetyNumberHint", { name })}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t(verified ? "share.unverifyFor" : "share.markVerifiedFor", { email })}
        onPress={() => onVerify(!verified)}
        className="flex-row items-center gap-1.5 self-start rounded-md border border-neutral-200 px-2 py-1 dark:border-neutral-700"
      >
        <ShieldCheck
          size={12}
          className={
            verified
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-neutral-600 dark:text-neutral-300"
          }
        />
        <Text className="text-xs text-neutral-700 dark:text-neutral-200">
          {verified ? t("share.unverify") : t("share.markVerified")}
        </Text>
      </Pressable>
    </View>
  );
}
