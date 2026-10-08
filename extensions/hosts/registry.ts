import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseTypeBoxValue } from "../shared/typebox.ts";
import {
  HOST_LAUNCH_RESULT_SCHEMA,
  HOST_SCHEMA,
  HOST_SESSION_SCHEMA,
  HOSTS_CHANNEL,
  type Host,
  type HostedSession,
  type HostLaunchInput,
} from "./contract.ts";

const RESERVED_NAMES = new Set([
  "left",
  "right",
  "up",
  "down",
  "deferred",
  "subagent",
  "tmux",
  "ghostty",
]);

export class HostRegistry {
  private hosts: readonly Host[] = [];

  discover(events: ExtensionAPI["events"]): void {
    const hosts: Host[] = [];
    let frozen = false;
    let registrationError: unknown;
    this.hosts = [];
    try {
      events.emit(HOSTS_CHANNEL, {
        register(value: unknown) {
          if (frozen) throw new Error("Host registration is closed.");
          try {
            const host = parseTypeBoxValue(HOST_SCHEMA, value, "Invalid host");
            if (RESERVED_NAMES.has(host.name) || hosts.some((entry) => entry.name === host.name)) {
              throw new Error(`Host name is reserved or already registered: ${host.name}`);
            }
            if (host.wake && !host.listSessions) {
              throw new Error(`Host ${host.name}: wake requires listSessions.`);
            }
            const name = host.name;
            const launch = host.launch.bind(host);
            const listSessions = host.listSessions?.bind(host);
            const wake = host.wake?.bind(host);
            hosts.push(
              Object.freeze({
                name,
                async launch(input: HostLaunchInput) {
                  return parseTypeBoxValue(
                    HOST_LAUNCH_RESULT_SCHEMA,
                    await launch(input),
                    `Host ${name} launch result`,
                  );
                },
                ...(listSessions
                  ? {
                      listSessions: async () =>
                        parseTypeBoxValue(
                          Type.Array(HOST_SESSION_SCHEMA),
                          await listSessions(),
                          `Host ${name} sessions`,
                        ),
                    }
                  : {}),
                ...(wake
                  ? {
                      async wake(target: string) {
                        parseTypeBoxValue(
                          Type.Void(),
                          await wake(target),
                          `Host ${name} wake result`,
                        );
                      },
                    }
                  : {}),
              }),
            );
          } catch (error) {
            registrationError = error;
            throw error;
          }
        },
      });
    } finally {
      frozen = true;
    }
    // Pi logs listener errors instead of propagating them through emit.
    if (registrationError) throw registrationError;
    this.hosts = Object.freeze(hosts);
  }

  getHosts(): readonly Host[] {
    return this.hosts;
  }

  async listSessions(): Promise<HostedSession[]> {
    const sessions = await Promise.all(
      this.hosts.map(async (host) => {
        if (!host.wake || !host.listSessions) return [];
        return (await host.listSessions()).map((session) => ({ ...session, host: host.name }));
      }),
    );
    const result = sessions.flat();
    const ids = new Set<string>();
    for (const session of result) {
      if (ids.has(session.sessionId))
        throw new Error(`Multiple hosts claim session ${session.sessionId}.`);
      ids.add(session.sessionId);
    }
    return result;
  }

  async owns(target: string): Promise<boolean> {
    return (await this.listSessions()).some((session) => session.sessionId === target);
  }

  async wake(target: string): Promise<void> {
    const hosts = this.hosts;
    const session = (await this.listSessions()).find((session) => session.sessionId === target);
    if (this.hosts !== hosts) throw new Error("The host registry changed while waking a session.");
    const host = hosts.find((host) => host.name === session?.host);
    if (!host?.wake) throw new Error(`No host can wake session ${target}.`);
    await host.wake(target);
  }
}
