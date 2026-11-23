// FILE: iishkoModelStatus.ts
// Purpose: Normalize and sort IISHKO model probe statuses for the status dialog.
// Layer: Web IISHKO account feature

import type { IishkoProfile } from "@iishko/contracts";

export type IishkoModelStatusKind = "up" | "busy" | "unstable" | "down" | "unavailable" | "unknown";

export interface IishkoModelStatusRow {
  readonly id: string;
  readonly title?: string | undefined;
  readonly kind: IishkoModelStatusKind;
  readonly latencyMs?: number | undefined;
  readonly reason?: string | undefined;
  readonly checkedAt?: number | undefined;
}

export interface IishkoLockedModelGroup {
  readonly minTier: string;
  readonly count: number;
}

export function iishkoModelStatusKind(
  status: string | undefined,
  unstable: boolean | undefined,
): IishkoModelStatusKind {
  switch (status) {
    case "up":
      return unstable === true ? "unstable" : "up";
    case "busy":
      return "busy";
    case "down":
      return "down";
    case "unavailable":
      return "unavailable";
    default:
      return unstable === true ? "unstable" : "unknown";
  }
}

const KIND_ORDER: Record<IishkoModelStatusKind, number> = {
  up: 0,
  busy: 1,
  unstable: 1,
  unknown: 2,
  down: 3,
  unavailable: 3,
};

function sortRows(rows: IishkoModelStatusRow[]): IishkoModelStatusRow[] {
  return rows.toSorted((a, b) => {
    const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (byKind !== 0) return byKind;
    return (a.title ?? a.id).localeCompare(b.title ?? b.id);
  });
}

type ProfileModel = IishkoProfile["models"]["available"][number];

function toRow(model: ProfileModel): IishkoModelStatusRow {
  return {
    id: model.id,
    ...(model.title !== undefined ? { title: model.title } : {}),
    kind: iishkoModelStatusKind(model.status, model.unstable),
    ...(model.latencyMs !== undefined ? { latencyMs: model.latencyMs } : {}),
    ...(model.reason !== undefined ? { reason: model.reason } : {}),
    ...(model.checkedAt !== undefined ? { checkedAt: model.checkedAt } : {}),
  };
}

/** Available models sorted up → busy/unstable → unknown → down/unavailable, then title. */
export function iishkoModelStatusRows(profile: IishkoProfile): IishkoModelStatusRow[] {
  return sortRows(profile.models.available.map(toRow));
}

/** Locked models collapsed by minimum rank tier. */
export function iishkoLockedModelGroups(profile: IishkoProfile): IishkoLockedModelGroup[] {
  const counts = new Map<string, number>();
  for (const model of profile.models.locked) {
    counts.set(model.minTier, (counts.get(model.minTier) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([minTier, count]) => ({ minTier, count }))
    .toSorted((a, b) => a.minTier.localeCompare(b.minTier));
}

/** Dot color class per status kind (uses theme tokens where possible). */
export function iishkoStatusDotClass(kind: IishkoModelStatusKind): string {
  switch (kind) {
    case "up":
      return "bg-emerald-500";
    case "busy":
      return "bg-yellow-500";
    case "unstable":
      return "bg-orange-500";
    case "down":
      return "bg-red-500";
    default:
      return "bg-muted-foreground/50";
  }
}
