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
  herdrPaneCreateRpc,
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
  NOTICE_TOAST_MS,
  PICKER_LIMIT,
  pickerItems,
  pickerPlace,
  plainState,
  plainRowTitle,
  rowActions,
  SHELL_INPUT_EXPLANATION,
  SHELL_INPUT_SETTINGS_PATH,
  statusGlyph,
  statusLabel,
  statusTone,
  validateFolder,
  withShellSwitch,
  workspaceText,
  type PickerKind,
} from "./helpers.js";
import { agentPlace } from "../shared/labels.js";
import { herdrNoticeSettings, herdrSettings, herdrViewSettings } from "../shared/settings.js";
import {
  DEFAULT_VIEW,
  SORT_FIELD_IDS,
  SORT_FIELDS,
  dirLabel,
  flatAgents,
  flattenOverview,
  groupAgents,
  normalizeView,
  pickField,
  toggleDir,
  type AgentGroup,
  type FlatAgent,
  type SortView,
} from "./sort.js";
import { clockSkewMs, classifyCache, tickIntervalMs } from "./time.js";
import { detailLines, rowTexts, type DetailLine } from "./row.js";
import { bindHerdrChat, bindNewPane, createHerdrChat, openHerdrTerminal, type NewAgentResult, type NewPane } from "./actions.js";
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
      shellExplain: { flexShrink: 1, minWidth: 0 },
      detailsWrap: { flexDirection: "row" as const, flexWrap: "wrap" as const, columnGap: 20, rowGap: 2 },
      detailsStacked: { gap: 2 },
      detailPair: { flexShrink: 1, minWidth: 0 },
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

/**
 * Glyph and word as well as colour. The word drops on a phone, where line 2 starts with it. A pane with no agent shows what
 * it runs (`Shell`, `vim`) in muted text, never an agent status.
 */
function StatusBadge({ agent, compact, theme, plainText }: { agent: OverviewAgent; compact: boolean; theme: Theme; plainText?: string }) {
  const c = theme.colors;
  const { plain, status } = agent;
  const tone = plain ? "muted" : statusTone(status);
  const color =
    tone === "success" ? c.statusSuccess : tone === "warning" ? c.statusWarning : tone === "accent" ? c.accent : c.foregroundMuted;
  const text = useMemo(() => ({ color, fontWeight: "600" as const }), [color]);
  return (
    <Text style={text} accessibilityElementsHidden importantForAccessibility="no">
      {plain ? "$" : statusGlyph(status)}
      {compact ? "" : ` ${plain ? plainText ?? plainState(agent) : statusLabel(status)}`}
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

/** What the screen hands every row so it can offer "Turn on shell input"; stable between renders so rows stay memoised. */
interface ShellControl {
  /** The setting could be read, so the switch can be saved. */
  available: boolean;
  pending: boolean;
  error: string | null;
  turnOn(): void;
}

/**
 * One line saying what shell input is, the action that turns it on, and the plain-text route to the same switch. The action
 * writes the same `Allow shell input` plugin setting as Settings > Plugins > herdr-harness; nothing flips it silently.
 */
function ShellInputAction({ shell, styles }: { shell: ShellControl; styles: Styles }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.muted, styles.shellExplain]}>{SHELL_INPUT_EXPLANATION}</Text>
      {shell.available ? (
        <Button label={shell.pending ? "Turning on…" : "Turn on shell input"} secondary disabled={shell.pending} onPress={shell.turnOn} styles={styles} />
      ) : null}
      <Text style={[styles.muted, styles.shellExplain]}>Or: {SHELL_INPUT_SETTINGS_PATH}</Text>
      {shell.error ? <Text accessibilityRole="alert" style={styles.danger}>{shell.error}</Text> : null}
    </View>
  );
}

/** The agent's facts, always visible in its row: exact times with their source, model, folder and the raw pane and terminal ids. */
function RowDetails({ lines, attachCommand, compact, styles }: { lines: DetailLine[]; attachCommand: string; compact: boolean; styles: Styles }) {
  const toast = useToast();
  const copy = useCallback(async () => {
    try {
      await copyText(attachCommand);
      toast.show("Copied", { variant: "success" });
    } catch {
      toast.error("Could not copy. Select the text and use Copy.");
    }
  }, [attachCommand, toast]);
  return (
    <View style={compact ? styles.detailsStacked : styles.detailsWrap}>
      {lines.map((line) => (
        <Text key={line.label} selectable style={styles.detailPair}>
          <Text style={styles.muted}>{line.label}: </Text>
          <Text style={styles.text}>{line.value}</Text>
        </Text>
      ))}
      <View style={styles.row}>
        <Text selectable style={[styles.muted, styles.detailPair]}>Attach from any terminal on this computer: <Text style={styles.text}>{attachCommand}</Text></Text>
        <Button label="Copy" secondary onPress={copy} styles={styles} />
      </View>
    </View>
  );
}

/** Opens a Herdr pane as a Paseo terminal and goes there. Shared by the row buttons, the terminal picker and the agent rows' "Open in terminal". */
function useOpenTerminal(navigation: Navigation) {
  const paseo = usePaseo();
  return useMutation({
    mutationFn: ({ agent, label }: { agent: OverviewAgent; label: string }) =>
      openHerdrTerminal(paseo, { cwd: agent.cwd, attach: agent.attach, name: `Herdr: ${label}` }),
    onSuccess: (workspaceId) => navigation?.openWorkspace({ workspaceId }),
  });
}

/**
 * Opens a Herdr agent's Paseo chat; an agent with none gets a chat bound to the running process (no new process) and then
 * opens it. Shared by the row button and the agent picker.
 */
function useOpenAgent(navigation: Navigation, onChanged: () => void) {
  const paseo = usePaseo();
  const ready = useRpc(herdrChatReadyRpc);
  const link = useMutation({
    mutationFn: ({ agent, label }: { agent: OverviewAgent; label: string }) => bindHerdrChat(paseo, ready, agent, label),
    onSuccess: (agentId) => {
      onChanged();
      navigation?.openAgent({ agentId });
    },
  });
  const { mutate, isPending } = link;
  const open = useCallback((agent: OverviewAgent, label: string) => {
    if (agent.paseoAgentId) navigation?.openAgent({ agentId: agent.paseoAgentId });
    else if (!isPending) mutate({ agent, label });
  }, [navigation, isPending, mutate]);
  return { link, open };
}

/**
 * One live Herdr pane: an agent or a plain terminal. Every action it has is a button in the row, nothing sits behind a menu.
 * Tapping the text of an agent row opens its chat. Memoised: the screen's clock tick re-renders every row, and a row repaints
 * only when the text it shows changed (`place`, `times`, `alert`, `speech` are plain values).
 */
const AgentRow = memo(function AgentRow({ item, place: placeLine, pin, times, alert, speech, compact, shellInput, shell, theme, styles, navigation, onChanged }: {
  item: FlatAgent; place: string; pin: string; times: string; alert: boolean; speech: string; compact: boolean; shellInput: boolean;
  shell: ShellControl; theme: Theme; styles: Styles; navigation: Navigation; onChanged(): void;
}) {
  const { agent } = item;
  const toast = useToast();
  const paseo = usePaseo();
  const [restarting, setRestarting] = useState(false);
  const { paseoAgentId, cwd } = agent;
  const label = agentLabel(agent);
  const place = agentPlace(agent.harness ?? agent.kind, agent.paneId);
  const readOnly = agent.inputReady === false;
  const idle = agent.status === "idle" || agent.status === "done";
  const fetchOverview = useRpc(herdrOverviewRpc);
  const ready = useRpc(herdrChatReadyRpc);
  const { link, open } = useOpenAgent(navigation, onChanged);
  const terminal = useOpenTerminal(navigation);
  // Built from the clock at render: the facts and their absolute times don't tick.
  const details = useMemo(() => detailLines(item, Date.now()), [item]);
  // Fallback if binding fails: Paseo's own Import session lists this agent under the same name.
  const folder = useMutation({
    mutationFn: async () => {
      if (!cwd) throw new Error("This agent has no folder path");
      return (await paseo.workspaces.open(cwd)).id;
    },
    onSuccess: (workspaceId) => {
      toast.show(`In the workspace's Import session list, pick “${label}” (${place})`, { variant: "info" });
      navigation?.openWorkspace({ workspaceId });
    },
  });
  const busy = link.isPending || folder.isPending || terminal.isPending;
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
  const actions = rowActions(agent, { shellInput, canNavigate: Boolean(navigation) });
  const plainTitle = agent.plain ? plainRowTitle(agent, label) : null;
  const titleName = plainTitle ? plainTitle.name : label;
  const openLabel = link.isPending ? "Opening…" : actions.openAgent === "bind" ? "Open agent" : agent.plain ? "Open chat" : "Open existing agent";
  const terminalLabel = terminal.isPending ? "Opening…" : agent.plain ? "Open existing terminal" : "Open in terminal";
  const newHereLabel = link.isPending ? "Starting…" : "New agent in this pane";
  const restartLabel = readOnly ? "Restart to enable input" : "Restart agent";
  return (
    <View style={styles.agent}>
      <Pressable
        accessibilityRole={actions.openAgent ? "button" : "text"}
        accessibilityLabel={actions.openAgent ? `Open chat: ${speech}` : speech}
        disabled={!actions.openAgent || busy}
        onPress={() => open(agent, label)}
        style={styles.agentMain}
      >
        <View style={styles.row}>
          <StatusBadge agent={agent} compact={compact && titleName !== null} theme={theme} plainText={plainTitle?.state} />
          {titleName !== null ? <Text style={styles.text} numberOfLines={1}>{titleName}</Text> : null}
          {agent.harness && !compact ? <Text style={styles.muted}>{agent.harness}</Text> : null}
        </View>
        {/* react-native-web turns middle truncation into end truncation, so the pane number sits outside the shortened text. */}
        <View style={styles.placeLine}>
          <Text style={[styles.muted, styles.placeText]} numberOfLines={1}>{placeLine}</Text>
          {pin ? <Text style={[styles.muted, styles.placePin]} numberOfLines={1}>{`${compact ? "·" : "›"} ${pin}`}</Text> : null}
        </View>
        {times ? <Text style={alert ? styles.warning : styles.muted}>{times}</Text> : null}
        {!agent.plain && !agent.provider ? <Text style={styles.muted}>No Paseo provider handles this agent kind.</Text> : null}
        {!agent.plain && agent.provider && !paseoAgentId ? (
          <Text style={styles.muted}>{link.isPending ? "Opening a chat…" : "No chat yet: Open agent attaches one to the running process."}</Text>
        ) : null}
        {agent.plain && !paseoAgentId ? <Text style={styles.muted}>No agent detected in this terminal.</Text> : null}
      </Pressable>
      <RowDetails lines={details} attachCommand={agent.attachCommand} compact={compact} styles={styles} />
      <View style={styles.row}>
        {actions.openAgent ? <Button label={openLabel} secondary disabled={busy} onPress={() => open(agent, label)} styles={styles} /> : null}
        {actions.openTerminal ? <Button label={terminalLabel} secondary disabled={busy} onPress={() => terminal.mutate({ agent, label })} styles={styles} /> : null}
        {actions.newAgentHere ? <Button label={newHereLabel} secondary disabled={busy} onPress={() => link.mutate({ agent, label })} styles={styles} /> : null}
        {actions.restart && (!readOnly || idle) ? <Button label={restartLabel} secondary={!readOnly} onPress={() => setRestarting(true)} styles={styles} /> : null}
        {duplicates.length > 0 ? (
          <Button label={archiveDuplicatesLabel(duplicates.length)} secondary disabled={archiveDuplicates.isPending} onPress={() => archiveDuplicates.mutate()} styles={styles} />
        ) : null}
      </View>
      {readOnly ? (
        <View style={styles.row}>
          <Text style={styles.warning}>Read-only: it started before the input companion was installed.</Text>
          {agent.canRestart && !idle ? <Text style={styles.muted}>Restart is available once it's idle.</Text> : null}
        </View>
      ) : null}
      {duplicates.length > 0 ? <Text style={styles.muted}>More than one chat is bound to this agent.</Text> : null}
      {actions.turnOnShell ? <ShellInputAction shell={shell} styles={styles} /> : null}
      {link.error ? (
        <View style={styles.row}>
          <Text accessibilityRole="alert" style={styles.danger}>Couldn't open a chat: {errorMessage(link.error)}</Text>
          {cwd && navigation && !agent.plain ? <Button label="Import it instead" secondary disabled={busy} onPress={() => folder.mutate()} styles={styles} /> : null}
        </View>
      ) : null}
      {folder.error ? <Text accessibilityRole="alert" style={styles.danger}>{errorMessage(folder.error)}</Text> : null}
      {terminal.error ? <Text accessibilityRole="alert" style={styles.danger}>{errorMessage(terminal.error)}</Text> : null}
      <RestartSheet agent={agent} label={label} open={restarting} onOpenChange={setRestarting} onRestarted={restarted} styles={styles} />
    </View>
  );
});

/** What to do with the result of "New agent": open the chat, go to the new terminal, or tell the user why neither was possible. */
function followNewAgent(result: NewAgentResult, navigation: Navigation, onNotice: (note: string) => void) {
  if (result.agentId !== null) navigation?.openAgent({ agentId: result.agentId });
  else if (result.note === null) navigation?.openWorkspace({ workspaceId: result.workspaceId });
  else onNotice(result.note);
}

function NewAgentButton({
  cwd,
  styles,
  navigation,
  onCreated,
  onNotice,
}: {
  cwd: string;
  styles: Styles;
  navigation: Navigation;
  onCreated(): void;
  onNotice(note: string): void;
}) {
  const paseo = usePaseo();
  const suggest = useRpc(herdrFoldersSuggestRpc);
  const ready = useRpc(herdrChatReadyRpc);
  const createWorkspace = useRpc(herdrWorkspaceCreateRpc);
  const mutation = useMutation({
    // A new Herdr workspace in the folder, then a chat bound to its first pane. No process is launched.
    mutationFn: () =>
      createHerdrChat(
        paseo,
        ready,
        cwd,
        async (folder) => {
          const created = await createWorkspace({ cwd: folder });
          if (!created.paneId || !created.terminalId) throw new Error("This Paseo daemon runs an older Herdr plugin; update it to start a chat from a folder.");
          return { label: created.label, paneId: created.paneId, terminalId: created.terminalId, cwd: created.cwd, shellInput: created.shellInput ?? false, attach: created.attach ?? null };
        },
        async (folder) => (await suggest({ query: folder })).resolved,
      ),
    onSuccess: (result) => {
      onCreated();
      followNewAgent(result, navigation, onNotice);
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

function NewChatForm({ styles, theme, navigation, onCreated, onNotice }: { styles: Styles; theme: Theme; navigation: Navigation; onCreated(): void; onNotice(note: string): void }) {
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
      <NewAgentButton cwd={cwd} styles={styles} navigation={navigation} onCreated={onCreated} onNotice={onNotice} />
    </View>
  );
}

/** One card: a workspace (grouped) or every agent (flat, `group.workspace` null). */
function WorkspaceCard({
  group,
  grouped,
  compact,
  nowMs,
  shellInput,
  shell,
  theme,
  styles,
  navigation,
  onChanged,
  onNotice,
}: {
  group: { workspace: AgentGroup["workspace"] | null; agents: FlatAgent[] };
  grouped: boolean;
  compact: boolean;
  nowMs: number;
  shellInput: boolean;
  shell: ShellControl;
  theme: Theme;
  styles: Styles;
  navigation: Navigation;
  onChanged(): void;
  onNotice(note: string): void;
}) {
  const { workspace, agents } = group;
  return (
    <View style={styles.card}>
      <Text style={styles.title} numberOfLines={1}>{workspace ? workspaceText(workspace) : "All terminals"}</Text>
      {workspace?.cwd ? <Text selectable style={styles.muted} numberOfLines={1}>{workspace.cwd}</Text> : null}
      {agents.length === 0 ? <Text style={styles.muted}>No terminals in this workspace.</Text> : null}
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
            shellInput={shellInput}
            shell={shell}
            theme={theme}
            styles={styles}
            navigation={navigation}
            onChanged={onChanged}
          />
        );
      })}
      {workspace && navigation ? (
        <NewAgentInWorkspaceButton workspace={workspace} styles={styles} navigation={navigation} onCreated={onChanged} onNotice={onNotice} />
      ) : null}
    </View>
  );
}

/**
 * "New agent in this workspace": a new Herdr tab with an empty shell (never a launched process). With shell input on, a chat is
 * bound to it; with it off, the new pane opens as a Paseo terminal and the screen goes there.
 */
function NewAgentInWorkspaceButton({ workspace, styles, navigation, onCreated, onNotice }: {
  workspace: NonNullable<AgentGroup["workspace"]>; styles: Styles; navigation: Navigation; onCreated(): void; onNotice(note: string): void;
}) {
  const paseo = usePaseo();
  const createPane = useRpc(herdrPaneCreateRpc);
  const ready = useRpc(herdrChatReadyRpc);
  const title = workspaceText(workspace);
  const mutation = useMutation({
    mutationFn: async () => {
      const pane: NewPane = await createPane({ workspaceId: workspace.id });
      return bindNewPane(paseo, ready, pane, workspace.cwd, title);
    },
    onSuccess: (result) => {
      onCreated();
      followNewAgent(result, navigation, onNotice);
    },
    // The pane exists even when the chat could not be attached, so the list must show it.
    onError: () => onCreated(),
  });
  const { isPending, error, mutate } = mutation;
  const start = useCallback(() => {
    if (!isPending) mutate();
  }, [isPending, mutate]);
  return (
    <View style={styles.row}>
      <Button label={isPending ? "Starting…" : "New agent in this workspace"} secondary disabled={isPending} onPress={start} styles={styles} />
      {error ? <Text accessibilityRole="alert" style={styles.danger}>{errorMessage(error)}</Text> : null}
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

/**
 * The "Open existing agent" and "Open existing terminal" pickers. Both list Herdr's own panes (from the overview), never Paseo's
 * chats or workspaces: the agent picker only panes with a detected agent, the terminal picker only panes with none. Both filter
 * on the workspace, tab and pane names as well as the title, program and folder.
 */
function HerdrPicker({ kind, items, open, onOpenChange, navigation, onChanged, theme, styles }: {
  kind: PickerKind; items: FlatAgent[]; open: boolean; onOpenChange(open: boolean): void; navigation: NonNullable<Navigation>;
  onChanged(): void; theme: Theme; styles: Styles;
}) {
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => pickerItems(items, kind, filter), [items, kind, filter]);
  const total = useMemo(() => pickerItems(items, kind, "").length, [items, kind]);
  const agentOpen = useOpenAgent(navigation, onChanged);
  const terminal = useOpenTerminal(navigation);
  const isAgent = kind === "agent";
  const noun = isAgent ? "agent" : "terminal";
  const pick = useCallback((item: FlatAgent) => {
    const label = agentLabel(item.agent);
    onOpenChange(false);
    if (isAgent) agentOpen.open(item.agent, label);
    else terminal.mutate({ agent: item.agent, label });
  }, [isAgent, agentOpen, terminal, onOpenChange]);
  const error = isAgent ? agentOpen.link.error : terminal.error;
  return (
    <Modal title={`Open existing ${noun}`} open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <Text style={styles.muted}>{isAgent ? "Herdr agents only." : "Herdr terminals only (panes with no agent)."}</Text>
        <TextInput
          accessibilityLabel={`Filter ${noun}s`}
          placeholder="Filter by workspace, tab, pane, title or folder"
          placeholderTextColor={theme.colors.foregroundMuted}
          value={filter}
          onChangeText={setFilter}
          style={styles.input}
        />
        {total === 0 ? <Text style={styles.muted}>{isAgent ? "No Herdr agents are running." : "No Herdr terminals without an agent."}</Text> : null}
        {total > 0 && shown.length === 0 ? <Text style={styles.muted}>{`No ${noun} matches.`}</Text> : null}
        {shown.map((item) => {
          const { agent } = item;
          const label = agentLabel(agent);
          const unavailable = isAgent ? !agent.paseoAgentId && !(agent.provider && agent.cwd) : !(agent.attach && agent.cwd);
          const sub = isAgent
            ? [agent.harness ?? agent.kind, statusLabel(agent.status), agent.paseoAgentId ? "has a chat" : "no chat yet"].filter(Boolean).join(" · ")
            : [plainState(agent), agent.cwd].filter(Boolean).join(" · ");
          return (
            <Pressable
              key={agent.terminalId}
              accessibilityRole="button"
              accessibilityLabel={`Open ${label}, ${pickerPlace(item)}`}
              disabled={unavailable}
              onPress={() => pick(item)}
              style={styles.option}
            >
              <Text style={styles.text} numberOfLines={1}>{label}</Text>
              <Text style={styles.muted} numberOfLines={1}>{pickerPlace(item)}</Text>
              <Text style={styles.muted} numberOfLines={1}>{unavailable ? `Can't be opened from here (${isAgent ? "no Paseo provider or folder" : "herdr command or folder not found"})` : sub}</Text>
            </Pressable>
          );
        })}
        {shown.length === PICKER_LIMIT ? <Text style={styles.muted}>Showing the first {PICKER_LIMIT}; filter to narrow.</Text> : null}
        {error ? <Text accessibilityRole="alert" style={styles.danger}>{errorMessage(error)}</Text> : null}
      </Modal.Content>
    </Modal>
  );
}

/**
 * Said when a new Herdr pane was opened but could not be shown as a terminal or a chat. A dialog with OK and "Don't show this
 * again"; once the latter is chosen the screen shows the same text as a toast three times as long.
 */
function ShellNoticeModal({ note, onClose, onNever, shell, styles }: {
  note: string | null; onClose(): void; onNever(): void; shell: ShellControl; styles: Styles;
}) {
  const onOpenChange = useCallback((next: boolean) => { if (!next) onClose(); }, [onClose]);
  return (
    <Modal title="New terminal opened" open={note !== null} onOpenChange={onOpenChange}>
      <Modal.Content>
        <Text style={styles.text}>{note}</Text>
        <ShellInputAction shell={shell} styles={styles} />
        <View style={styles.row}>
          <Button label="OK" onPress={onClose} styles={styles} />
          <Button label="Don't show this again" secondary onPress={onNever} styles={styles} />
        </View>
      </Modal.Content>
    </Modal>
  );
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

/**
 * "Turn on shell input" for the rows and the new-terminal dialog. It writes the same plugin setting as Settings > Plugins >
 * herdr-harness > Allow shell input (through the same helper, so the enable epoch moves too); it is only ever called by a tap.
 */
function useShellControl(onChanged: () => void): ShellControl {
  const settings = useSettings(herdrSettings);
  const latest = useRef(settings);
  latest.current = settings;
  const [state, setState] = useState<{ pending: boolean; error: string | null }>({ pending: false, error: null });
  const available = settings.status === "ready";
  const turnOn = useCallback(() => {
    const current = latest.current;
    if (current.status !== "ready") return;
    setState({ pending: true, error: null });
    void current.save(withShellSwitch(current.values, true, Date.now()), current.revision).then(
      (ok) => {
        setState({ pending: false, error: ok ? null : `Couldn't save the setting. Use ${SHELL_INPUT_SETTINGS_PATH}.` });
        if (ok) onChanged();
      },
      (error) => setState({ pending: false, error: errorMessage(error) }),
    );
  }, [onChanged]);
  return useMemo(() => ({ available, pending: state.pending, error: state.error, turnOn }), [available, state, turnOn]);
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
  const [picking, setPicking] = useState<PickerKind | null>(null);
  const closePicker = useCallback((next: boolean) => { if (!next) setPicking(null); }, []);
  const toast = useToast();
  const shell = useShellControl(refresh);
  const [notice, setNotice] = useState<string | null>(null);
  const notices = useSettings(herdrNoticeSettings);
  const hideShellNotice = notices.status === "ready" && notices.values.hideShellNotice;
  const showNotice = useCallback((note: string) => {
    if (hideShellNotice) toast.show(note, { variant: "info", durationMs: NOTICE_TOAST_MS });
    else setNotice(note);
  }, [hideShellNotice, toast]);
  const closeNotice = useCallback(() => setNotice(null), []);
  const neverNotice = useCallback(() => {
    setNotice(null);
    if (notices.status === "ready") void notices.save({ ...notices.values, hideShellNotice: true }, notices.revision);
  }, [notices]);
  // Only Herdr's own panes feed the pickers, so nothing from Paseo's workspaces or chats can appear in them.
  const paneItems = useMemo(() => (data?.workspaces ? flattenOverview(data.workspaces) : []), [data?.workspaces]);
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
        {navigation ? <Button label="Open existing agent" secondary onPress={() => setPicking("agent")} styles={styles} /> : null}
        {navigation ? <Button label="Open existing terminal" secondary onPress={() => setPicking("terminal")} styles={styles} /> : null}
      </View>
      {navigation ? (
        <HerdrPicker kind="agent" items={paneItems} open={picking === "agent"} onOpenChange={closePicker} navigation={navigation} onChanged={refresh} theme={theme} styles={styles} />
      ) : null}
      {navigation ? (
        <HerdrPicker kind="terminal" items={paneItems} open={picking === "terminal"} onOpenChange={closePicker} navigation={navigation} onChanged={refresh} theme={theme} styles={styles} />
      ) : null}
      <ShellNoticeModal note={notice} onClose={closeNotice} onNever={neverNotice} shell={shell} styles={styles} />
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
              shellInput={data.shellInput}
              shell={shell}
              theme={theme}
              styles={styles}
              navigation={navigation}
              onChanged={refresh}
              onNotice={showNotice}
            />
          ))}
          {data.connection.status === "connected" && navigation ? (
            <NewChatForm styles={styles} theme={theme} navigation={navigation} onCreated={refresh} onNotice={showNotice} />
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
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}
