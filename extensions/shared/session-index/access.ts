import { existsSync } from "node:fs";
import { parseTypeBoxValue } from "../typebox.ts";
import {
  INDEX_SCHEMA_VERSION,
  ROW_COUNT_SCHEMA,
  type SessionIndexDatabase,
  type SessionIndexStatus,
} from "./common.ts";
import {
  acquireIndexLock,
  disableOlderIndexClient,
  getIndexRecoveryMessage,
  isIndexClientDisabled,
  requestIndexRecovery,
} from "./recovery.ts";
import { getMetadata, openIndexDatabase } from "./schema.ts";

export type SessionIndexOpenMode = "read" | "write";

export interface WithSessionIndexOptions {
  mode: SessionIndexOpenMode;
  required: boolean;
  timeoutMs?: number | undefined;
}

export interface ValidSessionIndex {
  db: SessionIndexDatabase;
  status: SessionIndexStatus;
}

export function withSessionIndex<T>(
  indexPath: string,
  options: WithSessionIndexOptions & { required: true },
  read: (index: ValidSessionIndex) => T,
): T;
export function withSessionIndex<T>(
  indexPath: string,
  options: WithSessionIndexOptions & { required: false },
  read: (index: ValidSessionIndex) => T,
): T | undefined;
export function withSessionIndex<T>(
  indexPath: string,
  options: WithSessionIndexOptions,
  read: (index: ValidSessionIndex) => T,
): T | undefined {
  const opened = openValidatedSessionIndexInternal(indexPath, options);
  if (!opened) {
    return undefined;
  }

  try {
    return read(opened);
  } finally {
    opened.db.close();
  }
}

export function openValidatedSessionIndex(
  indexPath: string,
  options: WithSessionIndexOptions & { required: true },
): ValidSessionIndex;
export function openValidatedSessionIndex(
  indexPath: string,
  options: WithSessionIndexOptions & { required: false },
): ValidSessionIndex | undefined;
export function openValidatedSessionIndex(
  indexPath: string,
  options: WithSessionIndexOptions,
): ValidSessionIndex | undefined {
  return openValidatedSessionIndexInternal(indexPath, options);
}

function openValidatedSessionIndexInternal(
  indexPath: string,
  options: WithSessionIndexOptions,
): ValidSessionIndex | undefined {
  if (isIndexClientDisabled(indexPath)) return handleUnavailableIndex(indexPath, options);
  if (!existsSync(indexPath)) {
    return handleUnavailableIndex(indexPath, options);
  }

  let db: SessionIndexDatabase | undefined;
  let release: (() => void) | undefined;
  try {
    if (options.mode === "write") {
      release = acquireIndexLock(indexPath);
      if (!release) return handleUnavailableIndex(indexPath, options);
    }
    db = openIndexDatabase(indexPath, {
      create: false,
      mode: "read",
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    const version = Number(getMetadata(db, "schema_version"));
    if (version !== INDEX_SCHEMA_VERSION) {
      const invalidDb = db;
      db = undefined;
      invalidDb.close();
      release?.();
      release = undefined;
      if (version > INDEX_SCHEMA_VERSION) disableOlderIndexClient(indexPath);
      return handleUnavailableIndex(indexPath, options);
    }
    const status = getIndexStatusFromDb(indexPath, db);
    if (options.mode === "write") {
      db.close();
      db = undefined;
      db = openIndexDatabase(indexPath, {
        create: false,
        mode: "write",
        timeoutMs: options.timeoutMs,
      });
      const close = db.close;
      const unlock = release;
      db.close = () => {
        try {
          close();
        } finally {
          unlock?.();
        }
      };
      release = undefined;
    }
    return { db, status };
  } catch (error) {
    db?.close();
    release?.();
    return handleUnavailableIndex(indexPath, options, error);
  }
}

export function getIndexStatusFromDb(dbPath: string, db: SessionIndexDatabase): SessionIndexStatus {
  const schemaVersionRaw = getMetadata(db, "schema_version");
  const lastFullReindexAt = getMetadata(db, "indexed_at");
  const sessionCountRow = parseTypeBoxValue(
    ROW_COUNT_SCHEMA,
    db.prepare(`SELECT COUNT(*) as count FROM sessions`).get(),
    "Invalid session count row",
  );

  return {
    dbPath,
    exists: true,
    schemaVersion: schemaVersionRaw ? Number(schemaVersionRaw) : undefined,
    sessionCount: sessionCountRow.count,
    lastFullReindexAt,
  };
}

export function formatRequiredSessionIndexError(indexPath: string): string {
  return getIndexRecoveryMessage(indexPath) ?? "Session indexing in progress; try again shortly.";
}

function handleUnavailableIndex(
  indexPath: string,
  options: WithSessionIndexOptions,
  cause?: unknown,
): undefined {
  if (!isIndexClientDisabled(indexPath)) void requestIndexRecovery(indexPath);
  if (!options.required) {
    return undefined;
  }

  throw new Error(formatRequiredSessionIndexError(indexPath), { cause });
}
