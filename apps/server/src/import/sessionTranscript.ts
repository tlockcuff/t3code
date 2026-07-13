/**
 * Pure parsing logic for external provider session files.
 *
 * Two on-disk formats are supported:
 *  - Claude Code: `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<slug>/<sessionId>.jsonl`
 *  - Codex:       `<CODEX_HOME|~/.codex>/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl`
 *
 * Everything here operates on already-read lines so it can be unit tested without touching disk.
 */

export type ImportableProvider = "claude" | "codex";

export interface ImportableSessionSummary {
  readonly provider: ImportableProvider;
  /** Native session id handed back to the provider on resume. */
  readonly sessionId: string;
  readonly filePath: string;
  readonly cwd: string | null;
  readonly branch: string | null;
  /** Derived from the first real user message. */
  readonly title: string | null;
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
  readonly messageCount: number;
}

export type ImportedMessageRole = "user" | "assistant";

export interface ImportedMessage {
  readonly role: ImportedMessageRole;
  readonly text: string;
  readonly timestamp: string | null;
}

export interface ParsedSession {
  readonly summary: ImportableSessionSummary;
  readonly messages: ReadonlyArray<ImportedMessage>;
}

/** Claude writes whole synthetic sessions for title generation and topic detection; not user work. */
const CLAUDE_SYNTHETIC_PREFIXES = [
  "You write concise thread titles",
  "Analyze if this message indicates a new conversation topic",
];

/**
 * Harness-injected user turns — slash-command expansions, tool notifications, structured-output
 * nudges, local-command preambles. They are real parts of the transcript but nobody typed them, so
 * they must not be chosen as the session's title.
 */
const CLAUDE_INJECTED_PREFIXES = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<task-notification>",
  "<local-command-caveat>",
  "<local-command-stdout>",
  "<system-reminder>",
  "[structured-output-enforce]",
  "[Request ID:",
];

const isInjectedClaudePrompt = (text: string): boolean =>
  CLAUDE_INJECTED_PREFIXES.some((prefix) => text.startsWith(prefix));

const TITLE_MAX_LENGTH = 80;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

/** Collapses whitespace and truncates so a transcript line reads well as a thread title. */
export const deriveTitle = (text: string): string | null => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return null;
  if (normalized.length <= TITLE_MAX_LENGTH) return normalized;
  const clipped = normalized.slice(0, TITLE_MAX_LENGTH);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > 40 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
};

const isSyntheticClaudePrompt = (text: string): boolean =>
  CLAUDE_SYNTHETIC_PREFIXES.some((prefix) => text.startsWith(prefix));

/**
 * Claude message content is either a bare string or a parts array. Only `text` parts are real
 * conversation: `tool_use`/`tool_result`/`image` parts are rendered from activities, and tool
 * results are recorded with `type: "user"` — surfacing them verbatim would fabricate user turns.
 */
const readClaudeText = (message: unknown): string | null => {
  if (!isRecord(message)) return null;
  const content = message.content;
  if (typeof content === "string") return content.trim().length > 0 ? content : null;
  if (!Array.isArray(content)) return null;

  const parts: Array<string> = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== "text") continue;
    const text = asString(part.text);
    if (text !== null) parts.push(text);
  }
  const joined = parts.join("\n\n").trim();
  return joined.length > 0 ? joined : null;
};

/** Codex content parts are `input_text` (user) / `output_text` (assistant). */
const readCodexText = (payload: Record<string, unknown>): string | null => {
  const content = payload.content;
  if (!Array.isArray(content)) return null;

  const parts: Array<string> = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type !== "input_text" && part.type !== "output_text") continue;
    const text = asString(part.text);
    if (text !== null) parts.push(text);
  }
  const joined = parts.join("\n\n").trim();
  return joined.length > 0 ? joined : null;
};

/**
 * Codex replays external agent tool traffic as assistant `output_text` prefixed with these markers.
 * They are machine chatter, not prose the user should re-read.
 */
const isCodexToolEcho = (text: string): boolean =>
  text.startsWith("[external_agent_tool_call:") || text.startsWith("[external_agent_tool_result]");

/**
 * Codex injects project instructions and environment details as standalone leading *user* messages.
 * They are session setup rather than anything the user typed, so they must not become the thread
 * title or appear in the backfilled scrollback.
 */
const CODEX_PREAMBLE_PREFIXES = ["<INSTRUCTIONS>", "<environment_context>", "<user_instructions>"];

const isCodexInstructionPreamble = (text: string): boolean =>
  /^#\s*AGENTS\.md instructions for\s/.test(text) ||
  CODEX_PREAMBLE_PREFIXES.some((prefix) => text.startsWith(prefix));

const parseJsonLines = (lines: Iterable<string>): Array<Record<string, unknown>> => {
  const records: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // Sessions are appended to live; a torn trailing line is expected and skippable.
    }
  }
  return records;
};

export const parseClaudeSession = (
  filePath: string,
  lines: Iterable<string>,
): ParsedSession | null => {
  const records = parseJsonLines(lines);

  let sessionId: string | null = null;
  let cwd: string | null = null;
  let branch: string | null = null;
  let startedAt: string | null = null;
  let updatedAt: string | null = null;
  let sawSyntheticFirstPrompt = false;
  let sawRealUserMessage = false;
  const messages: Array<ImportedMessage> = [];

  for (const record of records) {
    // Subagent transcripts are interleaved into the same file; they are not the user's conversation.
    if (record.isSidechain === true) continue;

    sessionId ??= asString(record.sessionId);
    cwd ??= asString(record.cwd);
    branch ??= asString(record.gitBranch);

    const timestamp = asString(record.timestamp);
    if (timestamp !== null) {
      startedAt ??= timestamp;
      updatedAt = timestamp;
    }

    const type = record.type;
    if (type !== "user" && type !== "assistant") continue;

    const text = readClaudeText(record.message);
    if (text === null) continue;

    if (type === "user" && !sawRealUserMessage && isSyntheticClaudePrompt(text)) {
      sawSyntheticFirstPrompt = true;
      continue;
    }
    if (type === "user") sawRealUserMessage = true;

    messages.push({ role: type, text, timestamp });
  }

  if (sessionId === null) return null;
  // A file whose only prompt was a title-generation call is Claude's own bookkeeping.
  if (!sawRealUserMessage && sawSyntheticFirstPrompt) return null;
  if (messages.length === 0) return null;

  // A session with no human-authored turn is agent-internal bookkeeping (a subagent's
  // structured-output nudge, a task notification) — never something worth resuming.
  const firstUser = messages.find(
    (message) => message.role === "user" && !isInjectedClaudePrompt(message.text),
  );
  if (firstUser === undefined) return null;

  return {
    summary: {
      provider: "claude",
      sessionId,
      filePath,
      cwd,
      branch,
      title: deriveTitle(firstUser.text),
      startedAt,
      updatedAt,
      messageCount: messages.length,
    },
    messages,
  };
};

export const parseCodexSession = (
  filePath: string,
  lines: Iterable<string>,
): ParsedSession | null => {
  const records = parseJsonLines(lines);

  let sessionId: string | null = null;
  let cwd: string | null = null;
  let startedAt: string | null = null;
  let updatedAt: string | null = null;
  const messages: Array<ImportedMessage> = [];

  for (const record of records) {
    const timestamp = asString(record.timestamp);
    const payload = isRecord(record.payload) ? record.payload : null;

    if (record.type === "session_meta" && payload !== null) {
      sessionId ??= asString(payload.session_id) ?? asString(payload.id);
      cwd ??= asString(payload.cwd);
      startedAt ??= asString(payload.timestamp) ?? timestamp;
      continue;
    }

    if (timestamp !== null) updatedAt = timestamp;

    // `response_item/message` is the durable transcript; `event_msg/*` is live-stream chatter
    // that duplicates it.
    if (record.type !== "response_item" || payload === null || payload.type !== "message") continue;

    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = readCodexText(payload);
    if (text === null) continue;
    if (role === "assistant" && isCodexToolEcho(text)) continue;
    if (role === "user" && isCodexInstructionPreamble(text)) continue;

    messages.push({ role, text, timestamp });
  }

  if (sessionId === null) return null;
  if (messages.length === 0) return null;

  const firstUser = messages.find((message) => message.role === "user");

  return {
    summary: {
      provider: "codex",
      sessionId,
      filePath,
      cwd,
      // Codex rollouts do not record the git branch.
      branch: null,
      title: firstUser ? deriveTitle(firstUser.text) : null,
      startedAt,
      updatedAt: updatedAt ?? startedAt,
      messageCount: messages.length,
    },
    messages,
  };
};

export const parseSessionFile = (
  provider: ImportableProvider,
  filePath: string,
  lines: Iterable<string>,
): ParsedSession | null =>
  provider === "claude" ? parseClaudeSession(filePath, lines) : parseCodexSession(filePath, lines);
