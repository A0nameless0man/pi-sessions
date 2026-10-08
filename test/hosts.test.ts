import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Host, HostRegistrationRequest } from "../extensions/hosts/contract.ts";
import { HostRegistry } from "../extensions/hosts/registry.ts";
import { collectUserSessions } from "../extensions/session-handoff/board-loading.ts";
import { installHandoff } from "../extensions/session-handoff/install.ts";
import { findPendingHandoffBootstrap } from "../extensions/session-handoff/metadata.ts";
import { HANDOFF_TOOL_DETAILS_SCHEMA } from "../extensions/session-handoff/tool-contract.ts";
import { MessageRouter } from "../extensions/session-messaging/message-router.ts";
import { loadSettings } from "../extensions/shared/settings.ts";
import { parseTypeBoxValue } from "../extensions/shared/typebox.ts";
import {
  createFakeExtensionApi,
  createFakeModelRegistry,
  createFakeModelRuntime,
  createTestFilesystem,
} from "./test-helpers.ts";

const fs = createTestFilesystem("pi-sessions-host-");
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.cleanup();
});

function registerHost(host: Host) {
  const events = createEventBus();
  events.on("pi-sessions:hosts:v1", (request) =>
    (request as HostRegistrationRequest).register(host),
  );
  const registry = new HostRegistry();
  registry.discover(events);
  return { registry, events };
}

describe("host registration", () => {
  it("freezes registration after synchronous dispatch and replaces it on the next session", () => {
    const events = createEventBus();
    let request: HostRegistrationRequest | undefined;
    const off = events.on("pi-sessions:hosts:v1", (value) => {
      request = value as HostRegistrationRequest;
      request.register({ name: "swb", launch: async () => ({ success: true }) });
    });
    const registry = new HostRegistry();
    registry.discover(events);
    expect(registry.getHosts().map((host) => host.name)).toEqual(["swb"]);
    expect(() =>
      request?.register({ name: "late", launch: async () => ({ success: true }) }),
    ).toThrow("registration is closed");
    off();
    registry.discover(events);
    expect(registry.getHosts()).toEqual([]);
  });

  it.each([
    { name: "swb", launch: "not a function" },
    { name: "subagent", launch: async () => ({ success: true }) },
    { name: "swb", launch: async () => ({ success: true }), wake: async () => {} },
  ])("rejects invalid registration even when Pi swallows the listener error", (host) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const events = createEventBus();
    events.on("pi-sessions:hosts:v1", (request) =>
      (request as HostRegistrationRequest).register(host as never),
    );
    expect(() => new HostRegistry().discover(events)).toThrow();
  });

  it("validates host listings and launch results at the boundary", async () => {
    const { registry } = registerHost({
      name: "swb",
      launch: async () => undefined as never,
      listSessions: async () => [{ sessionId: "child" }] as never,
      wake: async () => {},
    });
    await expect(registry.listSessions()).rejects.toThrow("Host swb sessions");
    await expect(
      registry.getHosts()[0]?.launch({
        sessionId: "child",
        sessionFile: "/child.jsonl",
        cwd: "/repo",
        title: "Child",
        model: "smoke/scripted",
        resumeCommand: "pi --session-id child",
      }),
    ).rejects.toThrow("Host swb launch result");
  });
});

describe("host handoff through the installed tool", () => {
  it.each([false, true])(
    "suppresses splits and persists the child before host launch (cross-cwd: %s)",
    async (crossCwd) => {
      const root = fs.createTempDir();
      const cwd = join(root, "parent");
      const targetCwd = crossCwd ? join(root, "target") : cwd;
      for (const dir of new Set([cwd, targetCwd])) mkdirSync(dir);
      vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
      vi.stubEnv("TMUX", "/tmp/nonexistent-tmux,1,0");
      const parent = SessionManager.create(cwd, join(root, "custom-sessions"));
      parent.appendMessage({ role: "user", content: "Original work", timestamp: Date.now() });
      parent.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Handoff now" }],
        api: "openai-completions",
        provider: "smoke",
        model: "scripted",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const launch = vi.fn(async (input) => {
        const child = SessionManager.open(input.sessionFile);
        expect(child.getSessionId()).toBe(input.sessionId);
        expect(child.usesDefaultSessionDir()).toBe(true);
        expect(child.getCwd()).toBe(targetCwd);
        expect(findPendingHandoffBootstrap(child.getBranch())).toMatchObject({
          kind: "pending",
          bootstrap: {
            launch: "swb",
            bootstrapMode: "automatic",
            title: "Host child",
            requestResponse: false,
          },
        });
        expect(
          child
            .getBranch()
            .some((entry) => entry.type === "custom" && "subagent" in (entry.data as object)),
        ).toBe(false);
        return { success: true as const };
      });
      const { registry } = registerHost({ name: "swb", launch });
      const pi = createFakeExtensionApi();
      vi.mocked(pi.getThinkingLevel).mockReturnValue("off");
      const model = { provider: "smoke", id: "scripted", name: "Scripted" };
      const lifecycle = installHandoff(pi, {
        settings: loadSettings(),
        index: { path: join(root, "index.sqlite") },
        getModelRuntime: async () => createFakeModelRuntime({ available: [model] }) as never,
        getHosts: () => registry.getHosts(),
        getLaunchTargets: () => [
          {
            value: "subagent",
            requestResponseDefault: true,
            bootstrapMode: "automatic",
            approveProjectTrust: true,
            prepareChild() {},
            launch: async () => ({ success: true, backend: "tmux" }),
          },
        ],
        board: {},
      });
      const ctx = {
        cwd,
        model,
        hasUI: false,
        scopedModels: [],
        sessionManager: parent,
        modelRegistry: createFakeModelRegistry({ available: [model] }),
      };
      await lifecycle.onSessionStart?.(
        { type: "session_start", reason: "startup" } as never,
        ctx as never,
      );
      const tool = vi
        .mocked(pi.registerTool)
        .mock.calls.find(([tool]) => tool.name === "session_handoff")?.[0];
      if (!tool) throw new Error("Missing handoff tool");
      expect(tool.parameters).toMatchObject({
        properties: {
          launch: { anyOf: [{ const: "swb" }, { const: "deferred" }, { const: "subagent" }] },
        },
      });
      const result = await tool.execute(
        "handoff",
        { goal: "Continue independently", title: "Host child", launch: "swb", cwd: targetCwd },
        undefined,
        undefined,
        ctx as never,
      );
      expect(launch).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: expect.any(String),
          sessionFile: expect.stringContaining(`${root}/agent/sessions/`),
          cwd: targetCwd,
          title: "Host child",
          model: "smoke/scripted:off",
          resumeCommand: expect.stringContaining("--approve"),
        }),
      );
      expect(launch.mock.calls[0]?.[0].resumeCommand).not.toContain("--session-dir");
      expect(pi.exec).not.toHaveBeenCalled();
      parent.appendMessage({
        role: "toolResult",
        toolCallId: "handoff",
        toolName: "session_handoff",
        content: result.content,
        details: parseTypeBoxValue(HANDOFF_TOOL_DETAILS_SCHEMA, result.details, "handoff result"),
        isError: false,
        timestamp: Date.now(),
      });
      expect(collectUserSessions(parent.getEntries())).toEqual([
        expect.objectContaining({
          receipt: expect.objectContaining({ launch: "swb", backend: "swb", title: "Host child" }),
        }),
      ]);
    },
  );
});

describe("host wake-on-message", () => {
  it("coalesces wake and waits for broker registration before delivering either message", async () => {
    const wake = vi.fn(async () => {});
    const { registry } = registerHost({
      name: "swb",
      launch: async () => ({ success: true }),
      listSessions: async () => [{ sessionId: "dormant", cwd: "/repo", title: "Sleeping" }],
      wake,
    });
    let ready: ((value: boolean) => void) | undefined;
    const sendMessage = vi.fn(async () => ({
      delivered: true as const,
      messageId: "message",
      target: { sessionId: "dormant" },
    }));
    const waitForSession = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          ready = resolve;
        }),
    );
    const router = new MessageRouter(
      { listSessions: async () => [], waitForSession, sendMessage },
      [registry],
      () => 1,
    );
    const request = { target: "dormant", body: "Continue", requestResponse: false };
    const first = router.sendMessage(request);
    const second = router.sendMessage({ ...request, body: "Also check tests" });
    await vi.waitFor(() => expect(ready).toBeDefined());
    expect(wake).toHaveBeenCalledExactlyOnceWith("dormant");
    expect(waitForSession).toHaveBeenCalledExactlyOnceWith("dormant", 30_000);
    expect(sendMessage).not.toHaveBeenCalled();
    ready?.(true);
    await expect(first).resolves.toMatchObject({ delivered: true });
    await expect(second).resolves.toMatchObject({ delivered: true });
    expect(sendMessage.mock.calls).toHaveLength(2);
  });

  it("does not deliver after timeout or a session switch", async () => {
    let epoch = 1;
    const sendMessage = vi.fn();
    const waker = { owns: () => true, wake: vi.fn(async () => {}) };
    const waitForSession = vi.fn(async () => false);
    const router = new MessageRouter(
      { listSessions: async () => [], waitForSession, sendMessage },
      [waker],
      () => epoch,
    );
    const request = { target: "dormant", body: "Continue", requestResponse: false };
    await expect(router.sendMessage(request)).rejects.toThrow("did not register");
    waitForSession.mockImplementation(async () => {
      epoch += 1;
      return true;
    });
    await expect(router.sendMessage(request)).rejects.toThrow("current session changed");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
