import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

// Deliberately independent of pi-sessions imports: this is another extension's side of v1.
const INPUT = Type.Object({
  sessionId: Type.String(),
  sessionFile: Type.String(),
  cwd: Type.String(),
  title: Type.String(),
  model: Type.String(),
  resumeCommand: Type.String(),
});
type Input = Static<typeof INPUT>;
interface Request {
  register(host: {
    name: string;
    launch(input: Input): Promise<{ success: true }>;
    listSessions(): Promise<{ sessionId: string; cwd: string; title: string }[]>;
    wake(sessionId: string): Promise<void>;
  }): void;
}

export default function install(pi: ExtensionAPI): void {
  const socket = process.env.SMOKE_HOST_SOCKET;
  if (!socket) return;
  const store = join(getAgentDir(), "host-session.json");
  const read = (): Input => {
    const value: unknown = JSON.parse(readFileSync(store, "utf8"));
    if (!Value.Check(INPUT, value)) throw new Error("Invalid fake host session");
    return value;
  };
  const start = (input: Input): void => {
    execFileSync("tmux", [
      "-S",
      socket,
      "new-window",
      "-d",
      "-t",
      "host",
      "-n",
      input.sessionId,
      "-c",
      input.cwd,
      `env -u TMUX -u TMUX_PANE pi --approve --session-id '${input.sessionId}' --model '${input.model}'`,
    ]);
  };
  pi.events.on("pi-sessions:hosts:v1", (value) => {
    (value as Request).register({
      name: "fake-host",
      async launch(input) {
        if (!Value.Check(INPUT, input) || !existsSync(input.sessionFile))
          throw new Error("Child was not persisted before launch");
        writeFileSync(store, JSON.stringify(input));
        start(input);
        return { success: true };
      },
      async listSessions() {
        if (!existsSync(store)) return [];
        const { sessionId, cwd, title } = read();
        return [{ sessionId, cwd, title }];
      },
      async wake(target) {
        const input = read();
        if (input.sessionId !== target) throw new Error("Unknown host session");
        start(input);
      },
    });
  });
}
