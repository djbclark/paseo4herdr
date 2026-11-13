import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Pressable, Text, TextInput, View } from "react-native";
import { usePaseo, useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Modal, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  herdrAgentRestartRpc,
  herdrChatReadyRpc,
  herdrDuplicatesArchiveRpc,
  herdrFoldersSuggestRpc,
  herdrOverviewRpc,
  herdrWorkspaceCreateRpc,
  type OverviewAgent,
} from "../shared/rpc.js";
import {
  agentLabel,
  archiveDuplicatesLabel,
  archiveFailureMessage,
  companionBanner,
  describeTarget,
  duplicateArchiveSkippedMessage,
  duplicateChatsToArchive,
  errorMessage,
  freshDuplicatesToArchive,
  OVERVIEW_QUERY_KEY,
  OVERVIEW_REFETCH_MS,
  statusGlyph,
  statusLabel,
  statusTone,
  validateFolder,
} from "./helpers.js";
import { agentPlace } from "../shared/labels.js";
import { herdrViewSettings } from "../shared/settings.js";
import {
  DEFAULT_VIEW,
  SORT_FIELD_IDS,
  SORT_FIELDS,
  dirLabel,
  flatAgents,
  groupAgents,
  normalizeView,
  pickField,
  toggleDir,
  type AgentGroup,
  type FlatAgent,
  type SortView,
} from "./sort.js";
import { clockSkewMs, classifyCache, tickIntervalMs } from "./time.js";
import { detailLines, rowTexts } from "./row.js";
import { bindHerdrChat, createHerdrChat } from "./actions.js";
import { FolderField } from "./folder-field.js";

type Theme = PluginScreenProps["theme"];
type Navigation = PluginScreenProps["navigation"];

function useStyles(theme: Theme, compact: boolean) {
  return useMemo(() => {
    const c = theme.colors;
    const pad = compact ? 12 : 20;
    return {
      root: { padding: pad, gap: 16 },
      screen: { flex: 1, backgroundColor: c.surface0 },
      card: {
        backgroundColor: c.surface1,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: pad,
        gap: 8,
      },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      title: { color: c.foreground, fontSize: 16, fontWeight: "600" as const },
      text: { color: c.foreground },
      muted: { color: c.foregroundMuted },
      danger: { color: c.statusDanger },
      button: {
        backgroundColor: c.accent,
        borderRadius: 6,
        paddingHorizontal: 12,
        paddingVertical: 6,
      },
      buttonDisabled: {
        backgroundColor: c.accent,
        borderRadius: 6,
        paddingHorizontal: 12,
        paddingVertical: 6,
        opacity: 0.5,
      },
      buttonText: { color: c.accentForeground },
      secondary: {
        backgroundColor: c.surface2,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 6,
        paddingHorizontal: 12,
        paddingVertical: 6,
      },
      input: {
        backgroundColor: c.surface2,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        color: c.foreground,
        minWidth: compact ? 0 : 240,
        alignSelf: "stretch" as const,
      },
      list: {
        backgroundColor: c.surface1,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 6,
        marginTop: 4,
        maxHeight: compact ? 220 : 280,
        overflow: "hidden" as const,
      },
      option: { paddingHorizontal: 10, paddingVertical: compact ? 10 : 6, borderTopColor: c.border, borderTopWidth: 1 },
      optionLine: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, gap: 8 },
      indent: { paddingLeft: compact ? 8 : 16, gap: 6 },
      warning: { color: c.statusWarning },
      agent: { gap: 6, paddingVertical: 6, borderTopColor: c.border, borderTopWidth: 1 },
      agentLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      agentMain: { flex: 1, gap: 2 },
      chip: {
        backgroundColor: c.surface2,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 14,
        paddingHorizontal: 12,
        paddingVertical: 6,
      },
      chipOn: {
        backgroundColor: c.surface2,
        borderColor: c.accent,
        borderWidth: 1,
        borderRadius: 14,
        paddingHorizontal: 12,
        paddingVertical: 6,
      },
      detail: { flexDirection: "row" as const, gap: 12, alignItems: "flex-start" as const },
      detailLabel: { width: compact ? 96 : 120, flexShrink: 0 },
      detailValue: { flex: 1, minWidth: 0 },
      placeLine: { flexDirection: "row" as const, alignItems: "center" as const, flexWrap: "nowrap" as const, overflow: "hidden" as const },
      placeText: { flexShrink: 1, minWidth: 0 },
      placePin: { flexShrink: 0, marginLeft: 6 },
    };
  }, [theme, compact]);
}
type Styles = ReturnType<typeof useStyles>;

function Button({
  label,
  onPress,
  styles,
  disabled,
  secondary,
}: {
  label: string;
  onPress(): void;
  styles: Styles;
  disabled?: boolean;
  secondary?: boolean;
}) {
  const box = secondary ? styles.secondary : disabled ? styles.buttonDisabled : styles.button;
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={box}>
      <Text style={secondary ? styles.text : styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

/** Glyph and word as well as colour. The word drops on a phone, where line 2 starts with it. */
function StatusBadge({ status, compact, theme }: { status: OverviewAgent["status"]; compact: boolean; theme: Theme }) {
  const c = theme.colors;
  const tone = statusTone(status);
  const color =
    tone === "success" ? c.statusSuccess : tone === "warning" ? c.statusWarning : tone === "accent" ? c.accent : c.foregroundMuted;
  const text = useMemo(() => ({ color, fontWeight: "600" as const }), [color]);
  return (
    <Text style={text} accessibilityElementsHidden importantForAccessibility="no">
      {statusGlyph(status)}
      {compact ? "" : ` ${statusLabel(status)}`}
    </Text>
  );
}

/** Restart confirmation: the only destructive step, so it says exactly what happens. */
function RestartSheet({ agent, label, open, onOpenChange, onRestarted, styles }: {
  agent: OverviewAgent; label: string; open: boolean; onOpenChange(open: boolean): void; onRestarted(): void | Promise<void>; styles: Styles;
}) {
  const restart = useRpc(herdrAgentRestartRpc);
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: () => restart({ terminalId: agent.terminalId, paneId: agent.paneId }),
    onSuccess: () => {
      toast.show("Restarted; input is enabled", { variant: "success" });
      onOpenChange(false);
      void onRestarted();
    },
  });
  const { isPending, error, mutate } = mutation;
  const confirm = useCallback(() => {
    if (!isPending) mutate();
  }, [isPending, mutate]);
  const cancel = useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Modal title={`Restart ${label}?`} open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <Text style={styles.text}>
          {agent.harness ?? "The agent"} quits and resumes this same conversation in the same Herdr pane, which takes a few seconds. It then loads the input companion, so you can type here.
        </Text>
        <Text style={styles.muted}>Anything typed in its terminal but not sent is lost.</Text>
        <View style={styles.row}>
          <Button label={isPending ? "Restarting…" : "Restart"} disabled={isPending} onPress={confirm} styles={styles} />
          <Button label="Cancel" secondary disabled={isPending} onPress={cancel} styles={styles} />
        </View>
        {error ? <Text accessibilityRole="alert" style={styles.danger}>{errorMessage(error)}</Text> : null}
      </Modal.Content>
    </Modal>
  );
}

/** Less common actions for one agent. */
function MoreSheet({ item, label, open, onOpenChange, onRestart, navigation, styles }: {
  item: FlatAgent; label: string; open: boolean; onOpenChange(open: boolean): void; onRestart(): void; navigation: Navigation; styles: Styles;
}) {
  const { agent } = item;
  // Built when the sheet opens, from the clock then: the facts and their absolute times don't tick.
  const details = useMemo(() => (open ? detailLines(item, Date.now()) : []), [open, item]);
  const toast = useToast();
  const paseo = usePaseo();
  const { attach, cwd } = agent;
  // A Paseo terminal running `herdr agent attach` (no shell) in the Paseo workspace for the agent's folder.
  const terminal = useMutation({
    mutationFn: async () => {
      if (!attach || !cwd) throw new Error("This agent can't be opened in a terminal");
      const workspace = await paseo.workspaces.open(cwd);
      await workspace.terminals.create({ name: `Herdr: ${label}`, command: attach.command, args: attach.args });
      return workspace.id;
    },
    onSuccess: (workspaceId) => {
      onOpenChange(false);
      navigation?.openWorkspace({ workspaceId });
    },
  });
  const copy = useCallback(async () => {
    try {
      await copyText(agent.attachCommand);
      toast.show("Copied", { variant: "success" });
    } catch {
      toast.error("Could not copy. Select the text and use Copy.");
    }
  }, [agent.attachCommand, toast]);
  const restart = useCallback(() => {
    onOpenChange(false);
    onRestart();
  }, [onOpenChange, onRestart]);
  return (
    <Modal title={label} open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <Text style={styles.muted}>{[agentPlace(agent.harness ?? agent.kind, agent.paneId), cwd].filter(Boolean).join(" · ")}</Text>
        {details.length > 0 ? (
          <View style={styles.indent}>
            <Text style={styles.title}>Details</Text>
            {details.map((line) => (
              <View key={line.label} style={styles.detail}>
                <Text style={[styles.muted, styles.detailLabel]}>{line.label}</Text>
                <Text selectable style={[styles.text, styles.detailValue]}>{line.value}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {attach && cwd && navigation ? (
          <Button label={terminal.isPending ? "Opening…" : "Open in terminal"} secondary disabled={terminal.isPending} onPress={() => terminal.mutate()} styles={styles} />
        ) : null}
        {agent.canRestart ? <Button label="Restart agent" secondary onPress={restart} styles={styles} /> : null}
        <Text style={styles.muted}>Attach from any terminal on this computer:</Text>
        <View style={styles.row}>
          <Text selectable style={styles.text}>{agent.attachCommand}</Text>
          <Button label="Copy" secondary onPress={copy} styles={styles} />
        </View>
        {terminal.error ? <Text accessibilityRole="alert" style={styles.danger}>{errorMessage(terminal.error)}</Text> : null}
      </Modal.Content>
    </Modal>
  );
}

/**
 * One live Herdr agent. Tapping it opens its Paseo chat. Memoised: the screen's clock tick re-renders every row, and
 * a row repaints only when the text it shows changed (`place`, `times`, `alert`, `speech` are plain values).
 */
const AgentRow = memo(function AgentRow({ item, place: placeLine, pin, times, alert, speech, compact, theme, styles, navigation, onChanged }: {
  item: FlatAgent; place: string; pin: string; times: string; alert: boolean; speech: string; compact: boolean;
  theme: Theme; styles: Styles; navigation: Navigation; onChanged(): void;
}) {
  const { agent } = item;
  const toast = useToast();
  const paseo = usePaseo();
  const [more, setMore] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const { paseoAgentId, cwd } = agent;
  const label = agentLabel(agent);
  const place = agentPlace(agent.harness ?? agent.kind, agent.paneId);
  const readOnly = agent.inputReady === false;
  const idle = agent.status === "idle" || agent.status === "done";
  const ready = useRpc(herdrChatReadyRpc);
  const fetchOverview = useRpc(herdrOverviewRpc);
  // Not linked yet: create a chat bound to this running agent (no new process) and open it.
  const link = useMutation({
    mutationFn: () => bindHerdrChat(paseo, ready, agent, label),
    onSuccess: (agentId) => {
      onChanged();
      navigation?.openAgent({ agentId });
    },
  });
  // Fallback if binding fails: Paseo's own Import session lists this agent under the same name.
  const folder = useMutation({
    mutationFn: async () => {
      if (!cwd) throw new Error("This agent has no folder path");
      return (await paseo.workspaces.open(cwd)).id;
    },
    onSuccess: (workspaceId) => {
      toast.show(`In ⋯ → Import session, pick “${label}” (${place})`, { variant: "info" });
      navigation?.openWorkspace({ workspaceId });
    },
  });
  const busy = link.isPending || folder.isPending;
  const open = useCallback(() => {
    if (paseoAgentId) navigation?.openAgent({ agentId: paseoAgentId });
    else if (!busy) link.mutate();
  }, [paseoAgentId, navigation, busy, link]);
  // After a restart the old chat stays read-only (it was frozen), so open a fresh chat on the same
  // conversation and archive the old one; archived chats can be restored from Paseo's archive.
  const restarted = useCallback(async () => {
    onChanged();
    if (!paseoAgentId || !navigation) return;
    try {
      const fresh = await bindHerdrChat(paseo, ready, agent, label);
      await paseo.agents.ref(paseoAgentId).archive().catch(() => undefined);
      navigation.openAgent({ agentId: fresh });
    } catch (error) {
      toast.error(`Restarted, but couldn't reopen the chat: ${errorMessage(error)}`);
    }
  }, [onChanged, paseoAgentId, navigation, paseo, ready, agent, label, toast]);
  // Extra chats bound to this terminal make "tap an agent" ambiguous; the row's own chat is never archived.
  const duplicates = duplicateChatsToArchive(agent);
  const archiveOnServer = useRpc(herdrDuplicatesArchiveRpc);
  const archiveDuplicates = useMutation({
    // The row is up to one refetch old: archive only what a fresh overview still lists as duplicates of the same owner.
    // The fresh check never starts Herdr, and a degraded answer (Herdr down, chat list unavailable) archives nothing.
    // The server then re-reads the owner just before archiving (compare-and-archive), which closes most of the
    // window between this check and the archive calls; a daemon without that RPC fails the tap and archives nothing.
    mutationFn: async () => {
      const plan = freshDuplicatesToArchive(agent, await fetchOverview({ noAutoStart: true }));
      if (plan.skip) return { plan, failure: null };
      if (!agent.paseoAgentId) return { plan: { skip: "owner-changed" as const, archive: [] as [] }, failure: null };
      const result = await archiveOnServer({ terminalId: agent.terminalId, paneId: agent.paneId, ownerId: agent.paseoAgentId, ids: plan.archive });
      if (result.skip) return { plan: { skip: result.skip, archive: [] as [] }, failure: null };
      return { plan: null, failure: archiveFailureMessage(result.archived.length + result.failures.length, result.failures) };
    },
    onSuccess: ({ plan, failure }) => {
      onChanged();
      if (plan) toast.show(duplicateArchiveSkippedMessage(plan), { variant: "info" });
      else if (failure) toast.error(failure);
    },
    onError: (error) => toast.error(`Couldn't check the chats before archiving: ${errorMessage(error)}`),
  });
  const canOpen = Boolean(navigation && (paseoAgentId || (agent.provider && cwd)));
  return (
    <View style={styles.agent}>
      <View style={styles.agentLine}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open chat: ${speech}`}
          disabled={!canOpen || busy}
          onPress={open}
          style={styles.agentMain}
        >
          <View style={styles.row}>
            <StatusBadge status={agent.status} compact={compact} theme={theme} />
            <Text style={styles.text} numberOfLines={1}>{label}</Text>
            {agent.harness && !compact ? <Text style={styles.muted}>{agent.harness}</Text> : null}
          </View>
          {/* react-native-web turns middle truncation into end truncation, so the pane number sits outside the shortened text. */}
          <View style={styles.placeLine}>
            <Text style={[styles.muted, styles.placeText]} numberOfLines={1}>{placeLine}</Text>
            {pin ? <Text style={[styles.muted, styles.placePin]} numberOfLines={1}>{`${compact ? "·" : "›"} ${pin}`}</Text> : null}
          </View>
          {times ? <Text style={alert ? styles.warning : styles.muted}>{times}</Text> : null}
          {!agent.provider ? <Text style={styles.muted}>No Paseo provider handles this agent kind.</Text> : null}
          {agent.provider && !paseoAgentId ? (
            <Text style={styles.muted}>{link.isPending ? "Opening a chat…" : "No chat yet: tap to open one."}</Text>
          ) : null}
        </Pressable>
        <Button label="⋯" secondary onPress={() => setMore(true)} styles={styles} />
      </View>
      {readOnly ? (
        <View style={styles.row}>
          <Text style={styles.warning}>Read-only: it started before the input companion was installed.</Text>
          {agent.canRestart && idle ? <Button label="Restart to enable input" onPress={() => setRestarting(true)} styles={styles} /> : null}
          {agent.canRestart && !idle ? <Text style={styles.muted}>Restart is available once it's idle.</Text> : null}
        </View>
      ) : null}
      {duplicates.length > 0 ? (
        <View style={styles.row}>
          <Text style={styles.muted}>More than one chat is bound to this agent.</Text>
          <Button label={archiveDuplicatesLabel(duplicates.length)} secondary disabled={archiveDuplicates.isPending} onPress={() => archiveDuplicates.mutate()} styles={styles} />
        </View>
      ) : null}
      {link.error ? (
        <View style={styles.row}>
          <Text accessibilityRole="alert" style={styles.danger}>Couldn't open a chat: {errorMessage(link.error)}</Text>
          {cwd && navigation ? <Button label="Import it instead" secondary disabled={busy} onPress={() => folder.mutate()} styles={styles} /> : null}
        </View>
      ) : null}
      {folder.error ? <Text accessibilityRole="alert" style={styles.danger}>{errorMessage(folder.error)}</Text> : null}
      <MoreSheet item={item} label={label} open={more} onOpenChange={setMore} onRestart={() => setRestarting(true)} navigation={navigation} styles={styles} />
      <RestartSheet agent={agent} label={label} open={restarting} onOpenChange={setRestarting} onRestarted={restarted} styles={styles} />
    </View>
  );
});

function NewAgentButton({
  cwd,
  styles,
  navigation,
  onCreated,
}: {
  cwd: string;
  styles: Styles;
  navigation: Navigation;
  onCreated(): void;
}) {
  const paseo = usePaseo();
  const suggest = useRpc(herdrFoldersSuggestRpc);
  const mutation = useMutation({
    mutationFn: async () => {
      return createHerdrChat(paseo, cwd, async (folder) => (await suggest({ query: folder })).resolved);
    },
    onSuccess: (agentId) => {
      onCreated();
      navigation?.openAgent({ agentId });
    },
  });
  const { isPending, error, mutate } = mutation;
  const start = useCallback(() => {
    if (!isPending) mutate();
  }, [isPending, mutate]);
  return (
    <View style={styles.row}>
      <Button label={isPending ? "Starting…" : "New agent"} disabled={isPending || !cwd.trim() || !navigation} onPress={start} styles={styles} />
      {error ? (
        <Text accessibilityRole="alert" style={styles.danger}>
          {errorMessage(error)}
        </Text>
      ) : null}
    </View>
  );
}

function NewChatForm({ styles, theme, navigation, onCreated }: { styles: Styles; theme: Theme; navigation: Navigation; onCreated(): void }) {
  const [cwd, setCwd] = useState("");
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Start a chat</Text>
      <FolderField
        accessibilityLabel="New chat folder path"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={cwd}
        onChangeText={setCwd}
        styles={styles}
      />
      <NewAgentButton cwd={cwd} styles={styles} navigation={navigation} onCreated={onCreated} />
    </View>
  );
}

/** One card: a workspace (grouped) or every agent (flat, `group.workspace` null). */
function WorkspaceCard({
  group,
  grouped,
  compact,
  nowMs,
  ompEnabled,
  theme,
  styles,
  navigation,
  onChanged,
}: {
  group: { workspace: AgentGroup["workspace"] | null; agents: FlatAgent[] };
  grouped: boolean;
  compact: boolean;
  nowMs: number;
  ompEnabled: boolean;
  theme: Theme;
  styles: Styles;
  navigation: Navigation;
  onChanged(): void;
}) {
  const { workspace, agents } = group;
  return (
    <View style={styles.card}>
      <Text style={styles.title} numberOfLines={1}>{workspace ? `W${workspace.number} ${workspace.label}` : "All agents"}</Text>
      {workspace?.cwd ? <Text selectable style={styles.muted} numberOfLines={1}>{workspace.cwd}</Text> : null}
      {agents.length === 0 ? <Text style={styles.muted}>No agents running.</Text> : null}
      {agents.map((item) => {
        const texts = rowTexts(item, agentLabel(item.agent), nowMs, { compact, grouped });
        return (
          <AgentRow
            key={item.agent.terminalId}
            item={item}
            place={texts.place}
            pin={texts.pin}
            times={texts.times}
            alert={texts.alert}
            speech={texts.speech}
            compact={compact}
            theme={theme}
            styles={styles}
            navigation={navigation}
            onChanged={onChanged}
          />
        );
      })}
      {ompEnabled && workspace?.cwd ? (
        <NewAgentButton cwd={workspace.cwd} styles={styles} navigation={navigation} onCreated={onChanged} />
      ) : null}
    </View>
  );
}

/**
 * The sort choice, kept in the plugin's host-scoped view setting when it can be read and written, else in memory for this
 * session. (The SDK has no per-device store, so every device on this host shares one choice.)
 */
function useView(): [SortView, (next: SortView) => void] {
  const settings = useSettings(herdrViewSettings);
  const [local, setLocal] = useState<SortView | null>(null);
  const { status, save, reload } = settings;
  const ready = status === "ready" ? settings : null;
  const revision = ready ? ready.revision : null;
  // Read out as primitives: the SDK hands back a new `values` object every render, which would otherwise re-sort and repaint every row each tick.
  const field = ready?.values.field;
  const dir = ready?.values.dir;
  const grouped = ready?.values.grouped;
  const stored = useMemo(() => (ready ? normalizeView({ field, dir, grouped }) : DEFAULT_VIEW), [ready !== null, field, dir, grouped]);
  // The newest choice not yet saved. Saves go one at a time against the revision the last save produced, so two quick
  // choices (or one made while the setting is still loading) are not lost to a stale revision.
  const wanted = useRef<SortView | null>(null);
  const saving = useRef(false);
  const [saved, setSaved] = useState(0);
  useEffect(() => {
    const next = wanted.current;
    if (!next || revision === null || saving.current) return;
    if (next.field === stored.field && next.dir === stored.dir && next.grouped === stored.grouped) {
      wanted.current = null;
      return;
    }
    saving.current = true;
    void save({ field: next.field, dir: next.dir, grouped: next.grouped }, revision)
      .then((ok) => { if (!ok) return reload(); })
      .finally(() => { saving.current = false; setSaved((n) => n + 1); });
  }, [revision, stored, save, reload, local, saved]);
  const update = useCallback((next: SortView) => {
    wanted.current = next;
    setLocal(next);
  }, []);
  return [local ?? stored, update];
}

/**
 * The screen's one clock. It re-arms itself after each tick with `nextDelay()` (1 s while a countdown is under two minutes,
 * else 15 s) and stops while the app is in the background.
 */
function useTick(intervalMs: number): number {
  const [tick, setTick] = useState(0);
  // Keyed on the interval: when a countdown first appears or enters its last two minutes the timer restarts at once at 1 s,
  // not after the 15 s timer that was already running.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      timer = setTimeout(() => { setTick((n) => n + 1); arm(); }, intervalMs);
    };
    const stop = () => { if (timer) clearTimeout(timer); timer = undefined; };
    if (AppState.currentState === "active" || AppState.currentState === undefined) arm();
    const subscription = AppState.addEventListener("change", (next) => {
      stop();
      if (next === "active") { setTick((n) => n + 1); arm(); }
    });
    return () => { stop(); subscription.remove(); };
  }, [intervalMs]);
  return tick;
}

function SortPicker({ view, open, onOpenChange, onChange, styles }: {
  view: SortView; open: boolean; onOpenChange(open: boolean): void; onChange(next: SortView): void; styles: Styles;
}) {
  return (
    <Modal title="Sort by" open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        {SORT_FIELD_IDS.map((field) => (
          <Pressable
            key={field}
            accessibilityRole="button"
            accessibilityState={{ selected: field === view.field }}
            onPress={() => { onChange(pickField(view, field)); onOpenChange(false); }}
            style={styles.option}
          >
            <Text style={styles.text}>{field === view.field ? "✓ " : "   "}{SORT_FIELDS[field].label}</Text>
          </Pressable>
        ))}
      </Modal.Content>
    </Modal>
  );
}

function SortBar({ view, onChange, compact, styles }: { view: SortView; onChange(next: SortView): void; compact: boolean; styles: Styles }) {
  const [picking, setPicking] = useState(false);
  const arrow = view.dir === "asc" ? "↑" : "↓";
  const label = dirLabel(view.field, view.dir);
  return (
    <View style={styles.row}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Sort by ${SORT_FIELDS[view.field].label}`} onPress={() => setPicking(true)} style={styles.chip}>
        <Text style={styles.text}>Sort: {SORT_FIELDS[view.field].label} ▾</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`Direction: ${label}. Tap to reverse`} onPress={() => onChange(toggleDir(view))} style={styles.chip}>
        <Text style={styles.text}>{compact ? arrow : `${arrow} ${label}`}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={view.grouped ? "Grouped by workspace. Tap for one flat list" : "Flat list. Tap to group by workspace"}
        onPress={() => onChange({ ...view, grouped: !view.grouped })}
        style={view.grouped ? styles.chipOn : styles.chip}
      >
        <Text style={styles.text}>{view.grouped ? "Grouped" : "Flat"}</Text>
      </Pressable>
      <SortPicker view={view} open={picking} onOpenChange={setPicking} onChange={onChange} styles={styles} />
    </View>
  );
}

function NewWorkspaceForm({ styles, theme, onCreated }: { styles: Styles; theme: Theme; onCreated(): void }) {
  const create = useRpc(herdrWorkspaceCreateRpc);
  const [cwd, setCwd] = useState("");
  const [label, setLabel] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => create({ cwd: cwd.trim(), label: label.trim() || undefined }),
    onSuccess: () => {
      setCwd("");
      setLabel("");
      onCreated();
    },
  });
  const { isPending, error, mutate } = mutation;
  const submit = useCallback(() => {
    if (isPending) return;
    const invalid = validateFolder(cwd);
    setLocalError(invalid);
    if (!invalid) mutate();
  }, [isPending, cwd, mutate]);
  const shown = localError ?? (error ? errorMessage(error) : null);
  return (
    <View style={styles.card}>
      <Text style={styles.title}>New workspace</Text>
      <FolderField
        accessibilityLabel="Folder path"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={cwd}
        onChangeText={setCwd}
        editable={!isPending}
        onSubmitEditing={submit}
        styles={styles}
      />
      <TextInput
        accessibilityLabel="Label"
        placeholder="Label (optional)"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={label}
        onChangeText={setLabel}
        editable={!isPending}
        style={styles.input}
      />
      <View style={styles.row}>
        <Button label={isPending ? "Creating…" : "Create workspace"} disabled={isPending} onPress={submit} styles={styles} />
      </View>
      {shown ? (
        <Text accessibilityRole="alert" style={styles.danger}>
          {shown}
        </Text>
      ) : null}
    </View>
  );
}

export function HerdrOverviewScreen({ theme, layout, navigation }: PluginScreenProps) {
  const styles = useStyles(theme, layout.compact);
  const fetchOverview = useRpc(herdrOverviewRpc);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: OVERVIEW_QUERY_KEY,
    queryFn: () => fetchOverview({}),
    refetchInterval: OVERVIEW_REFETCH_MS,
  });
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY });
  }, [queryClient]);
  const data = query.data;
  const [view, setView] = useView();
  // Re-sorted only when new data arrives or the choice changes, never on a clock tick, so rows don't jump.
  const workspaces = data?.workspaces;
  const groups = useMemo(() => {
    if (!workspaces) return [];
    return view.grouped ? groupAgents(workspaces, view) : [{ workspace: null, agents: flatAgents(workspaces, view) }];
  }, [workspaces, view]);
  const skew = useMemo(() => clockSkewMs(data?.serverNow, query.dataUpdatedAt), [data?.serverNow, query.dataUpdatedAt]);
  // The interval comes from the clock as of this render, so it changes as soon as the data or a tick moves a countdown into
  // the fast window.
  const interval = tickIntervalMs(groups.flatMap((group) => group.agents.map((item) => classifyCache(item.agent.cache, item.agent.status, Date.now() + skew))));
  const tick = useTick(interval);
  // The device clock corrected by the daemon's, read once per render and handed to every row.
  const nowMs = useMemo(() => Date.now() + skew, [skew, tick, data]);
  const companionNotice = data ? companionBanner(data.companion, data.ompEnabled) : null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.root}>
      <View style={styles.row}>
        <Text style={styles.title}>Herdr</Text>
        <Button label={query.isFetching ? "Refreshing…" : "Refresh"} secondary onPress={refresh} styles={styles} />
      </View>
      {data && data.connection.status === "connected" ? <SortBar view={view} onChange={setView} compact={layout.compact} styles={styles} /> : null}
      {query.error ? (
        <Text accessibilityRole="alert" style={styles.danger}>
          {errorMessage(query.error)}
        </Text>
      ) : null}
      {!data && !query.error ? <Text style={styles.muted}>Loading…</Text> : null}
      {data ? (
        <>
          {companionNotice ? <Text accessibilityRole="alert" style={styles.warning}>{companionNotice}</Text> : null}
          {data.connection.status !== "connected" ? (
            <Text accessibilityRole="alert" style={styles.danger}>
              Herdr unavailable: {data.connection.error}
            </Text>
          ) : null}
          {data.chatError ? (
            <Text style={styles.warning}>Couldn't check which agents already have a Paseo chat: {data.chatError}</Text>
          ) : null}
          {data.connection.status === "connected" && data.workspaces.length === 0 ? (
            <Text style={styles.muted}>No Herdr workspaces yet. Start a chat in a folder below.</Text>
          ) : null}
          {groups.map((group) => (
            <WorkspaceCard
              key={group.workspace?.id ?? "all"}
              group={group}
              grouped={view.grouped}
              compact={layout.compact}
              nowMs={nowMs}
              ompEnabled={data.ompEnabled}
              theme={theme}
              styles={styles}
              navigation={navigation}
              onChanged={refresh}
            />
          ))}
          {data.connection.status === "connected" && data.ompEnabled && navigation ? (
            <NewChatForm styles={styles} theme={theme} navigation={navigation} onCreated={refresh} />
          ) : null}
          {data.connection.status === "connected" ? (
            <NewWorkspaceForm styles={styles} theme={theme} onCreated={refresh} />
          ) : null}
          <View style={styles.card}>
            <Text style={styles.title}>Connection</Text>
            {describeTarget(data.target).map((line) => (
              <Text key={line} selectable style={styles.muted}>
                {line}
              </Text>
            ))}
            {data.connection.status === "connected" ? (
              <Text style={styles.text}>
                Connected, Herdr {data.connection.version}
                {data.connection.autoStarted ? " (auto-started by Paseo)" : ""}
              </Text>
            ) : null}
            {!data.ompEnabled ? (
              <Text style={styles.muted}>OMP agents are turned off in Herdr settings, so New agent is hidden.</Text>
            ) : null}
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}
