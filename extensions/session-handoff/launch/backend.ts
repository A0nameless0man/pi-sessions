import type { Host, HostLaunchInput } from "../../hosts/contract.ts";

export type HandoffSplitDirection = "left" | "right" | "up" | "down";

export type LaunchInput = HostLaunchInput;

export type ClipboardStatus = "copied" | "failed";

export type LaunchBackend = Host;
