import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { safeParseTypeBoxValue } from "../shared/typebox.ts";

/**
 * The `acp` extension compress-and-prune plugin keeps its compression state in the session file as
 * `acp-state` custom entries, and removes the messages it has folded away at request time inside its
 * `context` hook. Auto-titling builds its own copy of the conversation, so that hook never runs for
 * a title request: without reading this state the titler would be sent entire conversations the
 * user's model no longer sees — tool output, thinking, and every message compression already
 * summarized away.
 *
 * The state shape is owned by the acp extension (`~/.pi/agent/extensions/acp/index.ts`,
 * `SessionState.prune`); only the fields this module reads are declared, and anything unrecognized
 * degrades to "no history" rather than dropping messages we cannot account for.
 */
export const ACP_STATE_CUSTOM_TYPE = "acp-state";

const ACP_MESSAGE_ENTRY_SCHEMA = Type.Object({
  /** Blocks currently standing in for this message. Non-empty means the message is pruned. */
  activeBlockIds: Type.Optional(Type.Array(Type.Number())),
});

const ACP_BLOCK_SCHEMA = Type.Object({
  blockId: Type.Optional(Type.Number()),
  active: Type.Optional(Type.Boolean()),
  /** Why a block stopped being active; `consumed` means a higher-tier block replaced it. */
  deactivatedBy: Type.Optional(Type.String()),
  topic: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  /** The `compress` tool call that carried this block's summary. */
  anchorToolCallId: Type.Optional(Type.String()),
});

const ACP_PRUNE_SCHEMA = Type.Object({
  byMessageId: Type.Optional(Type.Record(Type.String(), ACP_MESSAGE_ENTRY_SCHEMA)),
  blocksById: Type.Optional(Type.Record(Type.String(), ACP_BLOCK_SCHEMA)),
});

const ACP_STATE_SCHEMA = Type.Object({
  prune: Type.Optional(ACP_PRUNE_SCHEMA),
});

type AcpBlock = Static<typeof ACP_BLOCK_SCHEMA>;
type AcpPrune = Static<typeof ACP_PRUNE_SCHEMA>;

export interface AutoTitleCompressedSummary {
  topic: string | undefined;
  summary: string;
}

export interface AutoTitleAcpHistory {
  /** Entries whose messages compression has replaced with a summary. */
  prunedEntryIds: ReadonlySet<string>;
  /** Summary carriers the acp extension has hidden (a higher tier absorbed them). */
  hiddenAnchorEntryIds: ReadonlySet<string>;
  /** Summaries of the active blocks, oldest first. */
  summaries: readonly AutoTitleCompressedSummary[];
}

const NO_HISTORY: AutoTitleAcpHistory = {
  prunedEntryIds: new Set(),
  hiddenAnchorEntryIds: new Set(),
  summaries: [],
};

/**
 * Read the compression state the acp extension published on this branch. `branchEntries` must be the
 * entries of the active branch — a state entry from an abandoned branch describes messages that are
 * not in the conversation being titled.
 */
export function readAcpHistory(branchEntries: readonly SessionEntry[]): AutoTitleAcpHistory {
  const prune = latestPrune(branchEntries);
  if (!prune) {
    return NO_HISTORY;
  }

  const blocks = Object.values(prune.blocksById ?? {});
  return {
    prunedEntryIds: prunedEntryIds(prune),
    hiddenAnchorEntryIds: hiddenAnchorEntryIds(branchEntries, blocks),
    summaries: activeSummaries(blocks),
  };
}

function latestPrune(branchEntries: readonly SessionEntry[]): AcpPrune | undefined {
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = branchEntries[index];
    if (entry?.type !== "custom" || entry.customType !== ACP_STATE_CUSTOM_TYPE) {
      continue;
    }

    const state = safeParseTypeBoxValue(ACP_STATE_SCHEMA, entry.data);
    return state?.prune;
  }

  return undefined;
}

function prunedEntryIds(prune: AcpPrune): Set<string> {
  const pruned = new Set<string>();
  for (const [entryId, message] of Object.entries(prune.byMessageId ?? {})) {
    if ((message.activeBlockIds ?? []).length > 0) {
      pruned.add(entryId);
    }
  }

  return pruned;
}

function activeSummaries(blocks: readonly AcpBlock[]): AutoTitleCompressedSummary[] {
  return blocks
    .filter(
      (block): block is AcpBlock & { summary: string } =>
        block.active === true &&
        typeof block.summary === "string" &&
        block.summary.trim().length > 0,
    )
    .sort((left, right) => (left.blockId ?? 0) - (right.blockId ?? 0))
    .map((block) => ({ topic: block.topic?.trim() || undefined, summary: block.summary }));
}

/**
 * Port of the acp extension's anchor rule, narrowed to what a title request can observe: an
 * assistant message disappears once every tool call it carries belongs to a block group that is
 * fully consumed, so its text is no longer part of the conversation. A hidden tool *result* cannot
 * reach the title text in the first place.
 */
function hiddenAnchorEntryIds(
  entries: readonly SessionEntry[],
  blocks: readonly AcpBlock[],
): Set<string> {
  const hiddenCalls = consumedAnchorToolCallIds(blocks);
  const hidden = new Set<string>();
  if (hiddenCalls.size === 0) {
    return hidden;
  }

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }

    const callIds = toolCallIds(entry.message.content);
    if (callIds.length > 0 && callIds.every((callId) => hiddenCalls.has(callId))) {
      hidden.add(entry.id);
    }
  }

  return hidden;
}

function consumedAnchorToolCallIds(blocks: readonly AcpBlock[]): Set<string> {
  const byAnchor = new Map<string, AcpBlock[]>();
  for (const block of blocks) {
    if (!block.anchorToolCallId) {
      continue;
    }

    const group = byAnchor.get(block.anchorToolCallId) ?? [];
    group.push(block);
    byAnchor.set(block.anchorToolCallId, group);
  }

  const hidden = new Set<string>();
  for (const [toolCallId, group] of byAnchor) {
    if (!group.some((block) => block.active || block.deactivatedBy !== "consumed")) {
      hidden.add(toolCallId);
    }
  }

  return hidden;
}

function toolCallIds(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const ids: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) {
      continue;
    }

    const candidate = block as { type?: unknown; id?: unknown };
    if (candidate.type === "toolCall" && typeof candidate.id === "string") {
      ids.push(candidate.id);
    }
  }

  return ids;
}
