import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  getMetadata,
  INDEX_SCHEMA_VERSION,
  openIndexDatabase,
  searchSessions,
  setMetadata,
  withSessionIndex,
} from "../extensions/shared/session-index/index.ts";
import {
  observeIndexRecovery,
  readIndexRecoveryFailure,
  rebuildSessionIndex,
  requestIndexRecovery,
} from "../extensions/shared/session-index/recovery.ts";
import { createTestFilesystem } from "./test-helpers.ts";

const fs = createTestFilesystem("pi-index-recovery-");
afterEach(() => {
  vi.unstubAllEnvs();
  fs.cleanup();
});

function fixture() {
  const root = fs.createTempDir();
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  const file = fs.writeJsonlFile(path.join(root, "sessions", "project"), "valid.jsonl", [
    { type: "session", id: "prior", timestamp: "2026-10-09T00:00:00Z", cwd: root },
    {
      type: "message",
      id: "prompt",
      parentId: null,
      timestamp: "2026-10-09T00:00:01Z",
      message: { role: "user", content: "recoverable evidence" },
    },
  ]);
  const indexPath = path.join(root, "index.sqlite");
  const notices: string[] = [];
  observeIndexRecovery(indexPath, (message) => {
    if (message) notices.push(message);
  });
  return { root, file, indexPath, notices };
}

function search(indexPath: string) {
  return withSessionIndex(indexPath, { mode: "read", required: true }, ({ db }) =>
    searchSessions(db, {}),
  );
}

it("recovers on demand, skips broken transcripts, and reconciles drift without rebuilding current rows", async () => {
  const { root, file, indexPath, notices } = fixture();
  const broken = path.join(root, "sessions/project/broken.jsonl");
  writeFileSync(broken, '{"type":"session","id":"broken"}\n{"type":"message","message":null}\n');
  expect(() => search(indexPath)).toThrow("indexing in progress");
  expect(
    withSessionIndex(indexPath, { mode: "write", required: false }, () => true),
  ).toBeUndefined();
  await requestIndexRecovery(indexPath);
  expect(search(indexPath).map((session) => session.sessionId)).toEqual(["prior"]);
  expect(notices.join("\n")).toContain(broken);
  const inode = statSync(indexPath).ino;
  withSessionIndex(indexPath, { mode: "write", required: true }, ({ db }) => {
    db.prepare("UPDATE sessions SET index_source = 'unchanged'").run();
  });
  fs.writeJsonlFile(path.dirname(file), "drift.jsonl", [
    { type: "session", id: "drift", timestamp: "2026-10-09T01:00:00Z", cwd: root },
  ]);
  await requestIndexRecovery(indexPath, true);
  expect(search(indexPath).map((session) => session.sessionId)).toEqual(["drift", "prior"]);
  expect(statSync(indexPath).ino).toBe(inode);
  expect(
    withSessionIndex(indexPath, { mode: "read", required: true }, ({ db }) =>
      db.prepare("SELECT index_source FROM sessions WHERE session_id = 'prior'").get(),
    ),
  ).toEqual({ index_source: "unchanged" });
});

it("moves unreadable databases aside and only rebuilds older schemas", async () => {
  const { root, indexPath } = fixture();
  writeFileSync(indexPath, "broken database");
  expect(() => search(indexPath)).toThrow("indexing");
  await requestIndexRecovery(indexPath);
  expect(search(indexPath)).toHaveLength(1);
  const backup = readdirSync(root).find((file) => file.startsWith("index.sqlite.bad-"));
  expect(backup).toBeDefined();
  expect(readFileSync(path.join(root, backup ?? ""), "utf8")).toBe("broken database");
  withSessionIndex(indexPath, { mode: "write", required: true }, ({ db }) =>
    setMetadata(db, "schema_version", String(INDEX_SCHEMA_VERSION - 1)),
  );
  const inode = statSync(indexPath).ino;
  await Promise.all([requestIndexRecovery(indexPath), requestIndexRecovery(indexPath)]);
  expect(statSync(indexPath).ino).not.toBe(inode);
  const rebuilt = statSync(indexPath).ino;
  await requestIndexRecovery(indexPath);
  expect(statSync(indexPath).ino).toBe(rebuilt);
  expect(search(indexPath)).toHaveLength(1);
});

it("disables an older client without reading or changing newer-schema contents, including manual rebuild", async () => {
  const { indexPath, notices } = fixture();
  await rebuildSessionIndex({ indexPath });
  withSessionIndex(indexPath, { mode: "write", required: true }, ({ db }) =>
    setMetadata(db, "schema_version", String(INDEX_SCHEMA_VERSION + 1)),
  );
  const before = readFileSync(indexPath);
  expect(() => search(indexPath)).toThrow("pi-sessions was updated; /reload to use it");
  expect(
    withSessionIndex(indexPath, { mode: "write", required: false }, () => {
      throw new Error("must not execute");
    }),
  ).toBeUndefined();
  await expect(rebuildSessionIndex({ indexPath })).rejects.toThrow("/reload");
  expect(notices).toEqual(["pi-sessions was updated; /reload to use it"]);
  expect(readFileSync(indexPath)).toEqual(before);
});

it("persists failure backoff and lets a manual rebuild bypass it without destroying a readable index", async () => {
  const { indexPath, notices } = fixture();
  await rebuildSessionIndex({ indexPath });
  // Fail publication after the temporary database has been built.
  const blocker = openIndexDatabase(indexPath, { create: false });
  blocker.exec("PRAGMA journal_mode = WAL");
  blocker.exec("BEGIN IMMEDIATE");
  try {
    await expect(rebuildSessionIndex({ indexPath })).rejects.toThrow();
  } finally {
    blocker.close();
  }
  const first = readIndexRecoveryFailure(indexPath);
  expect(first).toMatchObject({
    attempts: 1,
    build: expect.stringMatching(/^index-v/),
    error: expect.any(String),
  });
  expect(first?.nextAllowedAt).toBeGreaterThan(Date.now() + 50_000);
  expect(search(indexPath)).toHaveLength(1);
  await requestIndexRecovery(indexPath, true);
  await requestIndexRecovery(indexPath, true);
  expect(readIndexRecoveryFailure(indexPath)).toEqual(first);
  expect(notices.filter((message) => message.includes("failed"))).toHaveLength(1);
  for (const [attempts, waitMs] of [
    [2, 300_000],
    [3, 1_800_000],
    [4, 1_800_000],
  ] as const) {
    const blocker = openIndexDatabase(indexPath, { create: false });
    blocker.exec("PRAGMA journal_mode = WAL");
    blocker.exec("BEGIN IMMEDIATE");
    const started = Date.now();
    try {
      await expect(rebuildSessionIndex({ indexPath })).rejects.toThrow();
    } finally {
      blocker.close();
    }
    const failure = readIndexRecoveryFailure(indexPath);
    expect(failure?.attempts).toBe(attempts);
    expect(failure?.nextAllowedAt).toBeGreaterThanOrEqual(started + waitMs);
    expect(failure?.nextAllowedAt).toBeLessThanOrEqual(Date.now() + waitMs);
  }
  await rebuildSessionIndex({ indexPath });
  expect(existsSync(`${indexPath}.failure.json`)).toBe(false);
  expect(search(indexPath)).toHaveLength(1);
  const db = openIndexDatabase(indexPath, { create: false, mode: "read" });
  expect(getMetadata(db, "schema_version")).toBe(String(INDEX_SCHEMA_VERSION));
  db.close();
});
