import type { HarnessInputTransport } from "./harnessSourceIdentity.js";

export interface HarnessObservation {
  schema_version: 1;
  harness_id: string;
  host_id: string;
  instance_id: string;
  source_kind: HarnessInputTransport;
  source_epoch: string;
  sequence?: number;
  event_id?: string;
  occurred_at?: number;
  evidence: "explicit" | "inferred";
  capabilities?: Partial<Record<"status" | "task" | "usage" | "workflow", "supported" | "unsupported" | "unknown">>;
}

export interface HarnessObservationCursor {
  source: string;
  epoch: string;
  retired_epochs: string[];
  sequence?: number;
  seen: string[];
}

export function validHarnessObservation(value: unknown): value is HarnessObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const shortString = (s: unknown) => typeof s === "string" && s.trim().length > 0 && s.length <= 256;
  if (v.schema_version !== 1 || !["harness_id", "host_id", "instance_id", "source_epoch"].every(k => shortString(v[k]))) return false;
  if (!["hook", "filesystem", "native_registry", "protocol", "otlp"].includes(String(v.source_kind))) return false;
  if (v.evidence !== "explicit" && v.evidence !== "inferred") return false;
  if (v.event_id !== undefined && !shortString(v.event_id)) return false;
  if (v.sequence !== undefined && (!Number.isSafeInteger(v.sequence) || (v.sequence as number) < 0)) return false;
  if (v.occurred_at !== undefined && (typeof v.occurred_at !== "number" || !Number.isFinite(v.occurred_at) || v.occurred_at < 0)) return false;
  if (v.capabilities !== undefined) {
    if (!v.capabilities || typeof v.capabilities !== "object" || Array.isArray(v.capabilities)) return false;
    if (!Object.entries(v.capabilities).every(([k, state]) => ["status", "task", "usage", "workflow"].includes(k) && ["supported", "unsupported", "unknown"].includes(state))) return false;
  }
  return true;
}

export function observeHarness(previous: readonly HarnessObservationCursor[], observation: HarnessObservation) {
  const source = JSON.stringify([observation.harness_id, observation.host_id, observation.instance_id, observation.source_kind]);
  const prior = previous.find(item => item.source === source);
  const retired = prior?.retired_epochs.includes(observation.source_epoch) ?? false;
  const sameEpoch = prior?.epoch === observation.source_epoch;
  const identity = observation.event_id !== undefined ? `id:${observation.event_id}` : observation.sequence !== undefined ? `seq:${observation.sequence}` : undefined;
  const key = identity && JSON.stringify([observation.source_epoch, identity]);
  if (key && prior?.seen.includes(key)) return { duplicate: true, late: false, cursors: previous };
  const late = retired || !!(sameEpoch && observation.sequence !== undefined && prior.sequence !== undefined && observation.sequence < prior.sequence);
  const cursor: HarnessObservationCursor = {
    source,
    epoch: late ? prior!.epoch : observation.source_epoch,
    retired_epochs: !late && prior && !sameEpoch ? [...prior.retired_epochs, prior.epoch].slice(-8) : [...(prior?.retired_epochs ?? [])],
    sequence: late ? prior?.sequence : sameEpoch ? observation.sequence ?? prior?.sequence : observation.sequence,
    seen: [...(prior?.seen ?? []), ...(key ? [key] : [])].slice(-64),
  };
  return { duplicate: false, late, cursors: [...previous.filter(item => item.source !== source), cursor].slice(-16) };
}
