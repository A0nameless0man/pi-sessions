import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionWaker, WakeMessaging } from "../session-messaging/message-router.ts";
import {
  createTmuxWindow,
  killTmuxWindow,
  listTmuxWindows,
  type TmuxExecutor,
  tmuxSessionName,
} from "../shared/tmux.ts";
import { findOwnedSubagentLaunch, type SubagentLaunched } from "./ledger.ts";

export interface WakeParentSession {
  sessionId: string;
  epoch: number;
  getBranch(): readonly SessionEntry[];
}

export class SubagentWaker implements SessionWaker {
  constructor(
    private readonly executor: TmuxExecutor,
    private readonly messaging: WakeMessaging,
    private readonly getParent: () => WakeParentSession | undefined,
    private readonly isCurrent: (epoch: number) => boolean,
    private readonly options: {
      onMaterialize?(launch: SubagentLaunched): void;
      afterSend?(): Promise<void> | void;
    } = {},
  ) {}

  owns(target: string): boolean {
    const parent = this.getParent();
    return Boolean(parent && findOwnedSubagentLaunch(parent.getBranch(), parent.sessionId, target));
  }

  async wake(target: string): Promise<void> {
    const { parent, launch } = this.resolve(target);
    const tmuxSession = tmuxSessionName(parent.sessionId);
    const hasWindow = (await listTmuxWindows(this.executor, tmuxSession)).some(
      (window) => window.piSessionId === target,
    );
    if (!hasWindow) await this.createWindow(parent, launch, tmuxSession);
  }

  async restart(target: string): Promise<void> {
    const { parent, launch } = this.resolve(target);
    const tmuxSession = tmuxSessionName(parent.sessionId);
    const killed = await killTmuxWindow(this.executor, tmuxSession, target);
    if (!killed) {
      throw new Error(
        `Subagent ${target} did not register and its stale tmux window could not be stopped.`,
      );
    }
    await this.createWindow(parent, launch, tmuxSession);
  }

  afterSend(): Promise<void> | void {
    return this.options.afterSend?.();
  }

  private resolve(target: string): { parent: WakeParentSession; launch: SubagentLaunched } {
    const parent = this.getParent();
    const launch = parent && findOwnedSubagentLaunch(parent.getBranch(), parent.sessionId, target);
    if (!parent || !launch) throw new Error(`No owned subagent ${target}.`);
    this.requireCurrent(parent);
    return { parent, launch };
  }

  private async createWindow(
    parent: WakeParentSession,
    launch: SubagentLaunched,
    tmuxSession: string,
  ): Promise<void> {
    if ((await this.messaging.listSessions()).includes(launch.childSessionId)) return;
    this.requireCurrent(parent);
    this.options.onMaterialize?.(launch);
    await createTmuxWindow(this.executor, {
      tmuxSession,
      name: launch.title,
      cwd: launch.cwd,
      command: launch.resumeCommand,
      piSessionId: launch.childSessionId,
    });
  }

  private requireCurrent(parent: WakeParentSession): void {
    if (!this.isCurrent(parent.epoch))
      throw new Error("The parent session changed while waking its subagent.");
  }
}
