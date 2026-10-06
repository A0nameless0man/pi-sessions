import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AutoTitleAcpHistory } from "./acp-history.ts";

/**
 * A title request is re-sent every few turns and is answered with under 80 characters, so the text
 * we hand the titler is bounded deliberately: user and assistant text only, no thinking, no tool
 * call arguments (a single `write` argument can dwarf the conversation), no tool output.
 *
 * Both limits are constants rather than settings. A title is a convenience, and an unbounded input
 * is what let a 7.5 MB session send ~600k tokens to the titler for a one-line answer.
 */

/** ~4k tokens of conversation: enough to name a session, cheap enough to repeat every few turns. */
export const TITLE_CONVERSATION_CHAR_LIMIT = 16_000;

/** One oversized prompt must not crowd out every other message. */
export const TITLE_MESSAGE_CHAR_LIMIT = 2_000;

export interface TitleConversationRow {
  entryId: string;
  sourceType: SessionEntry["type"];
  /** Compaction checkpoints keep their summary on the entry rather than in message content. */
  checkpointSummary: string | undefined;
  message: AgentMessage;
}

export interface TitleConversation {
  conversationText: string;
  compressedHistoryText: string | undefined;
}

interface ConversationLine {
  label: "[User]" | "[Assistant]";
  text: string;
}

export function buildTitleConversation(options: {
  rows: readonly TitleConversationRow[];
  history: AutoTitleAcpHistory;
}): TitleConversation {
  const visible = options.rows.filter(
    (row) =>
      !options.history.prunedEntryIds.has(row.entryId) &&
      !options.history.hiddenAnchorEntryIds.has(row.entryId),
  );

  return {
    conversationText: renderConversation(visible),
    compressedHistoryText: renderCompressedHistory({
      checkpoints: visible
        .map((row) => row.checkpointSummary)
        .filter((summary): summary is string => Boolean(summary?.trim())),
      summaries: options.history.summaries,
    }),
  };
}

function renderConversation(rows: readonly TitleConversationRow[]): string {
  const lines: ConversationLine[] = [];
  for (const row of rows) {
    const message = row.message;
    // Only the humans' own words: thinking, tool calls, tool results and system messages are all
    // content the titler cannot use but would pay for.
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const text = truncate(contentText(message.content, "").trim(), TITLE_MESSAGE_CHAR_LIMIT);
    if (text.length > 0) {
      lines.push({ label: message.role === "user" ? "[User]" : "[Assistant]", text });
    }
  }

  const selected = selectWithinBudget(lines, TITLE_CONVERSATION_CHAR_LIMIT);
  return selected
    .map((item) => (item.line ? `${item.line.label}: ${item.line.text}` : item.marker))
    .join("\n\n");
}

/**
 * Keep the newest messages that fit, and always keep the first user message — it states the task
 * even when it is long. Anything between the two is dropped with a marker, because a title needs the
 * shape of the conversation, not every turn of it.
 */
function selectWithinBudget(
  lines: readonly ConversationLine[],
  budget: number,
): Array<{ line?: ConversationLine; marker?: string }> {
  const total = lines.reduce((sum, line) => sum + lineCost(line), 0);
  if (total <= budget) {
    return lines.map((line) => ({ line }));
  }

  const firstUserIndex = lines.findIndex((line) => line.label === "[User]");
  const kept = new Set<number>();
  let remaining = budget;
  if (firstUserIndex >= 0) {
    kept.add(firstUserIndex);
    remaining -= lineCost(lines[firstUserIndex] as ConversationLine);
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (kept.has(index)) {
      continue;
    }

    const cost = lineCost(lines[index] as ConversationLine);
    if (cost > remaining) {
      break;
    }

    kept.add(index);
    remaining -= cost;
  }

  const omitted = lines.length - kept.size;
  const ordered = lines
    .map((line, index) => (kept.has(index) ? { line } : undefined))
    .filter((item): item is { line: ConversationLine } => item !== undefined);
  if (omitted === 0) {
    return ordered;
  }

  const marker = `[... ${omitted} earlier messages omitted ...]`;
  const insertAt = firstUserIndex >= 0 ? 1 : 0;
  return [...ordered.slice(0, insertAt), { marker }, ...ordered.slice(insertAt)];
}

function lineCost(line: ConversationLine): number {
  return line.label.length + line.text.length + 2;
}

/**
 * Compression summaries stand in for the messages that are no longer in context — the titler needs
 * them precisely because the pruned messages it is not being shown were part of the session. Both
 * sources are included: compaction checkpoints from pi itself, and the acp extension's active blocks.
 */
function renderCompressedHistory(options: {
  checkpoints: readonly string[];
  summaries: AutoTitleAcpHistory["summaries"];
}): string | undefined {
  const parts: string[] = [];
  let remaining = TITLE_CONVERSATION_CHAR_LIMIT;
  let omitted = 0;

  const push = (text: string) => {
    if (text.length + 1 > remaining) {
      omitted += 1;
      return;
    }

    remaining -= text.length + 1;
    parts.push(text);
  };

  for (const checkpoint of options.checkpoints) {
    push(`- Session checkpoint: ${truncate(checkpoint.trim(), TITLE_MESSAGE_CHAR_LIMIT)}`);
  }

  for (const summary of options.summaries) {
    const prefix = summary.topic ? `${summary.topic}: ` : "";
    push(`- ${prefix}${truncate(summary.summary.trim(), TITLE_MESSAGE_CHAR_LIMIT)}`);
  }

  if (parts.length === 0) {
    return undefined;
  }

  if (omitted > 0) {
    parts.push(`[... ${omitted} more summaries omitted ...]`);
  }

  return parts.join("\n");
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const head = Math.ceil(maxChars * 0.6);
  const tail = Math.max(maxChars - head, 0);
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[... ${omitted} characters omitted ...]\n${text.slice(
    text.length - tail,
  )}`;
}
