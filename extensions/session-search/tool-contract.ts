import { type Static, Type } from "typebox";
import {
  SESSION_LINEAGE_RELATION_SCHEMA,
  SESSION_ORIGIN_SCHEMA,
  type SearchSessionResult,
  type SearchSort,
  type SessionIndexStatus,
  type SessionKind,
} from "../shared/session-index/index.ts";

export interface SessionSearchToolParams {
  query?: string;
  files?: {
    touched?: string[];
    changed?: string[];
  };
  repo?: string;
  cwd?: string;
  time?: {
    after?: string;
    before?: string;
  };
  sort?: SearchSort;
  limit?: number;
  kind?: SessionKind;
}

export type SessionSearchResult = SearchSessionResult;

export interface SessionSearchToolDetails {
  params?: SessionSearchToolParams | undefined;
  results: SessionSearchResult[];
  status?: SessionIndexStatus | undefined;
}

export const SESSION_SEARCH_OUTPUT_SCHEMA = Type.Object({
  results: Type.Array(
    Type.Object({
      sessionId: Type.String(),
      sessionName: Type.String(),
      cwd: Type.String(),
      startedAt: Type.String(),
      modifiedAt: Type.String(),
      messageCount: Type.Number(),
      snippet: Type.String(),
      hitCount: Type.Number(),
      sessionOrigin: Type.Optional(SESSION_ORIGIN_SCHEMA),
      relation: Type.Optional(SESSION_LINEAGE_RELATION_SCHEMA),
      parentSessionId: Type.Optional(Type.String()),
    }),
  ),
});

export type SessionSearchOutput = Static<typeof SESSION_SEARCH_OUTPUT_SCHEMA>;
