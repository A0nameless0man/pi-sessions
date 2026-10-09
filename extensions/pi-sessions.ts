import {
  type ExtensionAPI,
  type ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { HostRegistry } from "./hosts/registry.ts";
import { installAsk } from "./session-ask/install.ts";
import { installAutoTitle } from "./session-auto-title/install.ts";
import { installHandoff } from "./session-handoff/install.ts";
import { installHooks } from "./session-hooks/install.ts";
import { installIndex } from "./session-index/install.ts";
import { installMessaging } from "./session-messaging/install.ts";
import { MessageRouter, type SessionWaker } from "./session-messaging/message-router.ts";
import { createSessionReachableTool } from "./session-messaging/pi/reachable-tool.ts";
import {
  createSessionCancelTool,
  createSessionSendMessageTool,
} from "./session-messaging/pi/tools.ts";
import { installSearch } from "./session-search/install.ts";
import type { SessionLifecycle } from "./shared/composition.ts";
import { createSessionModelRuntime, type ModelRuntimeProvider } from "./shared/model-runtime.ts";
import { loadSettings, readCompactionSettings } from "./shared/settings.ts";
import { installSubagents } from "./subagents/install.ts";

/**
 * The single advertised entrypoint. It loads settings once, constructs each feature in
 * dependency order, and wires them by constructor parameters.
 * It also owns the single `session_start`/`session_shutdown` subscription so lifecycle order
 * is deterministic: broker registration (messaging) resolves before any other feature hook,
 * and incoming messages start turns only once every feature hook has resolved.
 */
export default function piSessions(pi: ExtensionAPI): void {
  const settings = loadSettings();
  let sessionEpoch = 0;
  const hosts = new HostRegistry();

  // The mirrored ModelRuntime is expensive to build and only changes across session
  // boundaries, so cache it per epoch (the root's own invalidation signal) instead of
  // rebuilding it on every auto-title, /title, session_ask, and handoff draft.
  let cachedModelRuntime: { epoch: number; runtime: Promise<ModelRuntime> } | undefined;
  const getModelRuntime: ModelRuntimeProvider = (modelRegistry) => {
    if (cachedModelRuntime?.epoch !== sessionEpoch) {
      cachedModelRuntime = {
        epoch: sessionEpoch,
        runtime: createSessionModelRuntime(modelRegistry),
      };
    }
    return cachedModelRuntime.runtime;
  };

  const index = installIndex(pi, { settings });
  const messaging = settings.features.messaging
    ? installMessaging(pi, { settings, index })
    : undefined;

  const lifecycles: SessionLifecycle[] = [];
  if (messaging) {
    lifecycles.push(messaging);
  }
  const wakers: SessionWaker[] = [hosts];
  const messageRouter = messaging
    ? new MessageRouter(messaging, wakers, () => sessionEpoch)
    : undefined;
  const subagents =
    settings.features.subagents && messaging && messageRouter
      ? installSubagents(pi, {
          settings,
          messaging,
          readCompactionSettings,
          sendMessage: (request) => messageRouter.sendMessage(request),
          hasHostedSessions: () => hosts.getHosts().some((host) => Boolean(host.wake)),
        })
      : undefined;
  if (subagents) {
    wakers.unshift(subagents.waker);
    lifecycles.push(subagents);
  }
  const registerMessagingTools = (): void => {
    if (!messaging || !messageRouter) return;
    const isSubagent = subagents?.getParentSessionId() !== undefined;
    const hostedSessions = hosts.getHosts().some((host) => Boolean(host.wake));
    pi.registerTool(
      createSessionSendMessageTool(messageRouter, {
        role: isSubagent
          ? { kind: "subagent" }
          : subagents
            ? { kind: "wakeCapable" }
            : { kind: "plain" },
        hostedSessions,
        getCachedRelationTo: messaging.getCachedRelationTo,
        ...(subagents ? { getParentSessionId: () => subagents.getParentSessionId() } : {}),
      }),
    );
    pi.registerTool(
      createSessionCancelTool(subagents ?? messaging, {
        role: isSubagent ? { kind: "subagent" } : { kind: "plain" },
        ...(subagents ? { getParentSessionId: () => subagents.getParentSessionId() } : {}),
      }),
    );
    pi.registerTool(
      createSessionReachableTool({
        indexPath: index.path,
        hostedSessions,
        listSessions: () => messaging.listSessions(),
        listHostedSessions: () => hosts.listSessions(),
        getRelationTo: messaging.getCachedRelationTo,
        ...(subagents
          ? {
              listSubagents: async (scope) => (await subagents.roster.resolve(scope)).entries,
              getParentSessionId: () => subagents.getParentSessionId(),
            }
          : {}),
      }),
    );
  };
  registerMessagingTools();
  if (settings.features.handoff) {
    const board = {
      roster: subagents?.roster,
      cancelSubagent: subagents
        ? (sessionId: string) => subagents.cancelSession(sessionId)
        : undefined,
      listLiveSessions: messaging ? () => messaging.listSessions() : undefined,
      readSessionEntries: (sessionFile: string) => SessionManager.open(sessionFile).getEntries(),
    };
    lifecycles.push(
      installHandoff(pi, {
        settings,
        index,
        getModelRuntime,
        getHosts: () => hosts.getHosts(),
        ...(subagents ? { getLaunchTargets: () => subagents.getLaunchTargets() } : {}),
        board,
      }),
    );
  }
  if (settings.features.search) {
    installSearch(pi, { settings, index });
  }
  if (settings.features.ask) {
    installAsk(pi, {
      settings,
      index,
      getModelRuntime,
      ...(subagents
        ? { shouldMessageSubagent: (sessionId) => subagents.shouldMessageSubagent(sessionId) }
        : {}),
    });
  }
  if (settings.features.autoTitle) {
    lifecycles.push(
      installAutoTitle(pi, {
        settings,
        getModelRuntime,
        getSessionEpoch: () => sessionEpoch,
      }),
    );
  }
  lifecycles.push(index, installHooks(pi, { index, turnSync: settings.features.hooks }));
  // Messaging leads every session_start so the broker connection is registered before any
  // other feature hook runs. A side effect is that messaging's first relation snapshot can
  // predate hooks' index sync for this session; getCachedRelationTo self-heals on miss, so
  // this ordering is intentional — do not reorder to "fix" it.
  pi.on("session_start", async (event, ctx) => {
    sessionEpoch += 1;
    hosts.discover(pi.events);
    for (const lifecycle of lifecycles) {
      await lifecycle.onSessionStart?.(event, ctx);
    }
    registerMessagingTools();
    for (const lifecycle of lifecycles) {
      lifecycle.onSessionReady?.(ctx);
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    sessionEpoch += 1;
    for (let index = lifecycles.length - 1; index >= 0; index -= 1) {
      await lifecycles[index]?.onSessionShutdown?.(event, ctx);
    }
  });
}
