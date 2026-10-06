import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ACP_STATE_CUSTOM_TYPE } from "../extensions/session-auto-title/acp-history.ts";
import { buildAutoTitleContext } from "../extensions/session-auto-title/context.ts";
import {
  TITLE_CONVERSATION_CHAR_LIMIT,
  TITLE_MESSAGE_CHAR_LIMIT,
} from "../extensions/session-auto-title/conversation-text.ts";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: TIMESTAMP,
    message: { role: "user", content: [{ type: "text", text }] },
  } as unknown as SessionEntry;
}

function assistantEntry(
  id: string,
  parentId: string | null,
  options: { text?: string; thinking?: string; toolCallId?: string },
): SessionEntry {
  const content: unknown[] = [];
  if (options.thinking) {
    content.push({ type: "thinking", thinking: options.thinking });
  }
  if (options.text) {
    content.push({ type: "text", text: options.text });
  }
  if (options.toolCallId) {
    content.push({
      type: "toolCall",
      id: options.toolCallId,
      name: "compress",
      arguments: { startId: "m00001", endId: "m00002", summary: "SECRET SUMMARY" },
    });
  }

  return {
    type: "message",
    id,
    parentId,
    timestamp: TIMESTAMP,
    message: { role: "assistant", content },
  } as unknown as SessionEntry;
}

function toolResultEntry(
  id: string,
  parentId: string,
  toolCallId: string,
  text: string,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: TIMESTAMP,
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "bash",
      content: [{ type: "text", text }],
    },
  } as unknown as SessionEntry;
}

function acpStateEntry(
  id: string,
  parentId: string,
  prune: { byMessageId?: Record<string, unknown>; blocksById?: Record<string, unknown> },
): SessionEntry {
  return {
    type: "custom",
    id,
    parentId,
    timestamp: TIMESTAMP,
    customType: ACP_STATE_CUSTOM_TYPE,
    data: { prune },
  } as unknown as SessionEntry;
}

function compactionEntry(id: string, parentId: string, summary: string): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: TIMESTAMP,
    summary,
    firstKeptEntryId: id,
    tokensBefore: 1000,
  } as unknown as SessionEntry;
}

describe("auto-title context", () => {
  it("sends user and assistant text, and nothing else", () => {
    const entries = [
      userEntry("m1", null, "Fix the widget factory"),
      assistantEntry("m2", "m1", {
        thinking: "THINKING SECRET",
        text: "On it.",
        toolCallId: "call_1",
      }),
      toolResultEntry("m3", "m2", "call_1", "TOOL OUTPUT"),
    ];

    const context = buildAutoTitleContext(entries, "m3");

    expect(context.conversationText).toContain("[User]: Fix the widget factory");
    expect(context.conversationText).toContain("[Assistant]: On it.");
    expect(context.conversationText).not.toContain("THINKING SECRET");
    expect(context.conversationText).not.toContain("TOOL OUTPUT");
    expect(context.conversationText).not.toContain("[Assistant tool calls]");
    expect(context.compressedHistoryText).toBeUndefined();
  });

  it("drops messages compression replaced and shows their summary instead", () => {
    const entries = [
      userEntry("m1", null, "Fix the widget factory"),
      assistantEntry("m2", "m1", { text: "Compressed away" }),
      acpStateEntry("s1", "m2", {
        byMessageId: { m2: { tokenCount: 10, allBlockIds: [1], activeBlockIds: [1] } },
        blocksById: {
          1: {
            blockId: 1,
            active: true,
            topic: "widget",
            summary: "We renamed the widget factory.",
          },
        },
      }),
      userEntry("m3", "s1", "Now the tests"),
    ];

    const context = buildAutoTitleContext(entries, "m3");

    expect(context.conversationText).toContain("[User]: Now the tests");
    expect(context.conversationText).not.toContain("Compressed away");
    expect(context.compressedHistoryText).toBe("- widget: We renamed the widget factory.");
  });

  it("ignores compression state from an abandoned branch", () => {
    const entries = [
      userEntry("m1", null, "Fix the widget factory"),
      acpStateEntry("s1", "m1", {
        byMessageId: { m1: { tokenCount: 10, allBlockIds: [1], activeBlockIds: [1] } },
      }),
      userEntry("m2", "m1", "Start over"),
    ];

    const context = buildAutoTitleContext(entries, "m2");

    expect(context.conversationText).toContain("[User]: Fix the widget factory");
  });

  it("drops a summary carrier a higher tier consumed", () => {
    const entries = [
      userEntry("m1", null, "Fix the widget factory"),
      assistantEntry("m2", "m1", { text: "Compressing now", toolCallId: "call_1" }),
      acpStateEntry("s1", "m2", {
        byMessageId: { m1: { tokenCount: 10, allBlockIds: [1], activeBlockIds: [] } },
        blocksById: {
          1: { blockId: 1, active: false, deactivatedBy: "consumed", anchorToolCallId: "call_1" },
        },
      }),
    ];

    const context = buildAutoTitleContext(entries, "s1");

    expect(context.conversationText).toContain("[User]: Fix the widget factory");
    expect(context.conversationText).not.toContain("Compressing now");
  });

  it("keeps the first user message and the newest turns within the budget", () => {
    const filler = "x".repeat(1200);
    const entries: SessionEntry[] = [userEntry("m0", null, "The original task statement")];
    let parentId = "m0";
    for (let index = 1; index <= 20; index += 1) {
      const id = `m${index}`;
      entries.push(userEntry(id, parentId, `turn ${index} ${filler}`));
      parentId = id;
    }

    const context = buildAutoTitleContext(entries, parentId);

    expect(context.conversationText).toContain("The original task statement");
    expect(context.conversationText).toContain("turn 20");
    expect(context.conversationText).not.toContain("turn 2 ");
    expect(context.conversationText).toContain("earlier messages omitted");
    expect(context.conversationText.length).toBeLessThanOrEqual(TITLE_CONVERSATION_CHAR_LIMIT + 64);
  });

  it("truncates a single oversized message", () => {
    const entries = [userEntry("m1", null, `${"a".repeat(4000)}TAIL`)];
    const context = buildAutoTitleContext(entries, "m1");

    expect(context.conversationText).toContain("characters omitted");
    expect(context.conversationText).toContain("TAIL");
    expect(context.conversationText.length).toBeLessThanOrEqual(TITLE_MESSAGE_CHAR_LIMIT + 64);
  });

  it("counts turns from the whole conversation, not the pruned view", () => {
    const entries = [
      userEntry("m1", null, "Fix the widget factory"),
      assistantEntry("m2", "m1", { text: "Compressed away" }),
      acpStateEntry("s1", "m2", {
        byMessageId: { m2: { tokenCount: 10, allBlockIds: [1], activeBlockIds: [1] } },
      }),
      userEntry("m3", "s1", "Now the tests"),
    ];

    const context = buildAutoTitleContext(entries, "m3");

    expect(context.userTurnCount).toBe(2);
    expect(context.assistantTurnCount).toBe(1);
  });

  it("carries compaction checkpoints as compressed history", () => {
    const summary = "Earlier work: renamed the widget factory and its tests.";
    const entries = [
      userEntry("m1", null, "Fix the widget factory"),
      compactionEntry("c1", "m1", summary),
      userEntry("m2", "c1", "Now the tests"),
    ];

    const context = buildAutoTitleContext(entries, "m2");

    expect(context.conversationText).not.toContain("renamed the widget factory");
    expect(context.compressedHistoryText).toBe(`- Session checkpoint: ${summary}`);
  });
});
