import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { readAcpHistory } from "./acp-history.ts";
import { buildTitleConversation, type TitleConversationRow } from "./conversation-text.ts";

export interface AutoTitleContext {
  cwd: string | undefined;
  currentTitle: string | undefined;
  conversationText: string;
  /** Summaries of history that compression folded away; absent when nothing was compressed. */
  compressedHistoryText?: string;
  userTurnCount: number;
  assistantTurnCount: number;
}

/**
 * Build the titler's view of the conversation.
 *
 * This does not reuse pi's `serializeConversation` (the compaction helper) on purpose: that format
 * includes thinking, full tool call arguments and tool output, which is exactly what a title does
 * not need — see `conversation-text.ts`. Going through `buildSessionProjection` instead keeps every
 * message tied to the entry that produced it, which is what lets compression state be honored: the
 * acp extension prunes inside its own `context` hook, and a title request never passes through it.
 */
export function buildAutoTitleContext(
  entries: SessionEntry[],
  leafId: string | null,
  options?: { cwd?: string; currentTitle?: string | undefined },
): AutoTitleContext {
  const projection = buildSessionProjection(entries, leafId);
  const rows = toConversationRows(projection.entries);
  const history = readAcpHistory(projection.entries.map((entry) => entry.sourceEntry));
  const { conversationText, compressedHistoryText } = buildTitleConversation({ rows, history });

  let userTurnCount = 0;
  let assistantTurnCount = 0;
  for (const message of projection.messages) {
    if (message.role === "user") {
      userTurnCount += 1;
    } else if (message.role === "assistant") {
      assistantTurnCount += 1;
    }
  }

  return {
    cwd: options?.cwd,
    currentTitle: options?.currentTitle,
    conversationText,
    ...(compressedHistoryText ? { compressedHistoryText } : {}),
    userTurnCount,
    assistantTurnCount,
  };
}

function toConversationRows(
  projectedEntries: ReturnType<typeof buildSessionProjection>["entries"],
): TitleConversationRow[] {
  return projectedEntries.flatMap(({ sourceEntry, messages }) =>
    messages.map((message) => ({
      entryId: sourceEntry.id,
      sourceType: sourceEntry.type,
      checkpointSummary: sourceEntry.type === "compaction" ? sourceEntry.summary : undefined,
      message,
    })),
  );
}
