import { type Static, Type } from "typebox";

export const HOSTS_CHANNEL = "pi-sessions:hosts:v1";

export const HOST_LAUNCH_INPUT_SCHEMA = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  sessionFile: Type.String({ minLength: 1 }),
  cwd: Type.String({ minLength: 1 }),
  title: Type.String(),
  model: Type.String({ minLength: 1 }),
  resumeCommand: Type.String({ minLength: 1 }),
});

export const HOST_LAUNCH_RESULT_SCHEMA = Type.Union([
  Type.Object({
    success: Type.Literal(true),
    clipboardStatus: Type.Optional(Type.Union([Type.Literal("copied"), Type.Literal("failed")])),
  }),
  Type.Object({ success: Type.Literal(false), error: Type.String() }),
]);

export const HOST_SESSION_SCHEMA = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  cwd: Type.String({ minLength: 1 }),
  title: Type.String(),
});

export const HOST_SCHEMA = Type.Object({
  name: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
  launch: Type.Function([HOST_LAUNCH_INPUT_SCHEMA], Type.Unknown()),
  listSessions: Type.Optional(Type.Function([], Type.Unknown())),
  wake: Type.Optional(Type.Function([Type.String()], Type.Unknown())),
});

export type HostLaunchInput = Static<typeof HOST_LAUNCH_INPUT_SCHEMA>;
export type HostLaunchResult = Static<typeof HOST_LAUNCH_RESULT_SCHEMA>;
export type HostSession = Static<typeof HOST_SESSION_SCHEMA>;
export interface Host {
  name: string;
  launch(input: HostLaunchInput): Promise<HostLaunchResult>;
  listSessions?(): Promise<HostSession[]>;
  wake?(sessionId: string): Promise<void>;
}

export interface HostedSession extends HostSession {
  host: string;
}

export interface HostRegistrationRequest {
  register(host: Host): void;
}
