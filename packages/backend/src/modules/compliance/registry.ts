import type { Jurisdiction, RuleSetRules, RuleSetVersion } from "./types.js";
import { validateRuleSet } from "./rules.js";

/**
 * Versioned rule set store with jurisdiction enablement (Requirements 12.1, 12.8).
 * Versions are immutable. A raffle keeps the id of the version it was created under, so later
 * rule changes or enabling a jurisdiction never affect existing raffles.
 */
export class RuleSetRegistry {
  private readonly versions: RuleSetVersion[] = [];
  private readonly enabledAt = new Map<Jurisdiction, Date>();

  /** Add a new version. Throws on an invalid rule set or a duplicate (jurisdiction, effectiveFrom). */
  addVersion(v: RuleSetVersion): RuleSetVersion {
    const errors = validateRuleSet(v.rules);
    if (errors.length > 0) {
      throw new Error(
        `invalid rule set: ${errors.map((e) => `${e.field}:${e.constraint}`).join(",")}`,
      );
    }
    if (
      this.versions.some(
        (x) =>
          x.id === v.id ||
          (x.jurisdiction === v.jurisdiction &&
            x.effectiveFrom.getTime() === v.effectiveFrom.getTime()),
      )
    ) {
      throw new Error("duplicate rule set version");
    }
    const frozen: RuleSetVersion = {
      id: v.id,
      jurisdiction: v.jurisdiction,
      effectiveFrom: new Date(v.effectiveFrom),
      rules: structuredClone(v.rules) as RuleSetRules,
    };
    this.versions.push(frozen);
    return frozen;
  }

  /** Enable a jurisdiction from `at`. Re-enabling keeps the earliest enablement time. */
  enableJurisdiction(jurisdiction: Jurisdiction, at: Date): void {
    if (!this.enabledAt.has(jurisdiction)) this.enabledAt.set(jurisdiction, new Date(at));
  }

  isEnabled(jurisdiction: Jurisdiction, at: Date): boolean {
    const t = this.enabledAt.get(jurisdiction);
    return t !== undefined && t.getTime() <= at.getTime();
  }

  enabledJurisdictions(at: Date): Jurisdiction[] {
    return [...this.enabledAt.entries()]
      .filter(([, t]) => t.getTime() <= at.getTime())
      .map(([j]) => j);
  }

  /**
   * Snapshot reference for a raffle being created at `createdAt`: the latest version effective
   * at that time. Returns null when the jurisdiction is not enabled yet or has no version.
   */
  snapshotFor(jurisdiction: Jurisdiction, createdAt: Date): RuleSetVersion | null {
    if (!this.isEnabled(jurisdiction, createdAt)) return null;
    let best: RuleSetVersion | null = null;
    for (const v of this.versions) {
      if (v.jurisdiction !== jurisdiction || v.effectiveFrom.getTime() > createdAt.getTime())
        continue;
      if (best === null || v.effectiveFrom.getTime() > best.effectiveFrom.getTime()) best = v;
    }
    return best;
  }

  getById(id: string): RuleSetVersion | null {
    return this.versions.find((v) => v.id === id) ?? null;
  }
}
