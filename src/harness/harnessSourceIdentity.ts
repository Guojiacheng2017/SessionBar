import { createHash } from "node:crypto";

export type HarnessInputTransport = "hook" | "filesystem" | "native_registry" | "protocol" | "otlp";

export interface HarnessSourceIdentity {
  harness: string;
  transport: HarnessInputTransport;
  native_session_id: string;
  event_kind: string;
  native_event_id?: string;
  semantic_fingerprint?: string;
  artifact?: string;
  cursor?: string;
}

/**
 * Produce a transport-independent event identity for Runtime dedupe.
 * Adapters should prefer a native event id, then a fingerprint built only from
 * canonical non-sensitive facts. Artifact position is intentionally last-resort.
 */
export function harnessDedupeKey(identity: HarnessSourceIdentity): string {
  const stableIdentity = identity.native_event_id
    ? ["native", identity.harness, identity.native_session_id, identity.native_event_id]
    : identity.semantic_fingerprint
      ? ["semantic", identity.harness, identity.native_session_id, identity.event_kind, identity.semantic_fingerprint]
      : identity.artifact && identity.cursor
        ? ["artifact", identity.harness, identity.native_session_id, identity.event_kind, identity.artifact, identity.cursor]
        : undefined;
  if (!stableIdentity) throw new Error("Harness source identity requires a native id, semantic fingerprint, or artifact cursor");
  return `harness:${createHash("sha256").update(JSON.stringify(stableIdentity)).digest("hex").slice(0, 24)}`;
}
