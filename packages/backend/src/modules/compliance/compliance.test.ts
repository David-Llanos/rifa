import { describe, expect, it } from "vitest";
import { manualClock } from "@raffle/shared";
import {
  ComplianceService,
  DocumentService,
  InMemoryReviewQueue,
  RuleSetRegistry,
  ageOn,
  checkPurchaseLocation,
  evaluateRules,
  requiredDisclosures,
  validateEvidenceFile,
  type RuleSetRules,
  type RuleSetVersion,
} from "./index.js";

const rules = (maxMinor = 1_000_000n): RuleSetRules => ({
  permittedTypes: ["standard"],
  maxPrize: { amountMinor: maxMinor, currency: "USD" },
  requiredLicenses: ["state_raffle_license"],
  disclosures: ["odds"],
  tax: { withholdingBps: 0, reportingPeriodDays: 365, reportingForm: "W-2G" },
  prohibitedOwnerTypes: ["government"],
});

const version = (id: string, j: string, from: Date, r = rules()): RuleSetVersion => ({
  id,
  jurisdiction: j,
  effectiveFrom: from,
  rules: r,
});

const subject = {
  jurisdiction: "US-CA",
  raffleType: "standard",
  prizeValue: { amountMinor: 500n, currency: "USD" as const },
  ownerType: "individual",
};

describe("evaluateRules", () => {
  it("returns no violations when compliant", () => {
    expect(evaluateRules(subject, rules())).toEqual([]);
  });

  it("names each violated rule with its configured value", () => {
    const v = evaluateRules(
      {
        ...subject,
        raffleType: "lottery",
        ownerType: "government",
        prizeValue: { amountMinor: 2_000_000n, currency: "USD" },
      },
      rules(),
    );
    expect(v.map((x) => x.rule).sort()).toEqual([
      "maxPrize",
      "permittedTypes",
      "prohibitedOwnerTypes",
    ]);
    expect(v.find((x) => x.rule === "permittedTypes")?.configured).toEqual(["standard"]);
  });
});

describe("validateEvidenceFile", () => {
  it("accepts pdf/jpg/png up to 10 MB", () => {
    expect(validateEvidenceFile({ size: 10 * 1024 * 1024, mime: "application/pdf" })).toBeNull();
    expect(validateEvidenceFile({ size: 1, mime: "image/png" })).toBeNull();
  });
  it("rejects oversize and wrong format", () => {
    expect(
      validateEvidenceFile({ size: 10 * 1024 * 1024 + 1, mime: "image/jpeg" })?.constraint,
    ).toBe("size");
    expect(validateEvidenceFile({ size: 5, mime: "image/gif" })?.constraint).toBe("format");
  });
});

describe("checkPurchaseLocation", () => {
  it("allows enabled and rejects others or unresolved", () => {
    expect(checkPurchaseLocation(["CO"], { jurisdiction: "CO" }).ok).toBe(true);
    expect(checkPurchaseLocation(["CO"], { jurisdiction: "US-NY" }).ok).toBe(false);
    expect(checkPurchaseLocation(["CO"], { jurisdiction: null }).ok).toBe(false);
  });
});

describe("registry snapshots", () => {
  it("keeps the raffle's version and applies enablement to new raffles only", () => {
    const reg = new RuleSetRegistry();
    const t0 = new Date("2025-01-01T00:00:00Z");
    const t1 = new Date("2025-06-01T00:00:00Z");
    reg.addVersion(version("v1", "US-CA", t0));
    expect(reg.snapshotFor("US-CA", new Date("2025-02-01T00:00:00Z"))).toBeNull();
    reg.enableJurisdiction("US-CA", new Date("2025-03-01T00:00:00Z"));
    const snap = reg.snapshotFor("US-CA", new Date("2025-04-01T00:00:00Z"));
    expect(snap?.id).toBe("v1");
    reg.addVersion(version("v2", "US-CA", t1, rules(5n)));
    expect(reg.getById("v1")?.rules.maxPrize.amountMinor).toBe(1_000_000n);
    expect(reg.snapshotFor("US-CA", new Date("2025-07-01T00:00:00Z"))?.id).toBe("v2");
  });

  it("rejects max prize above 999,999,999.99", () => {
    const reg = new RuleSetRegistry();
    expect(() =>
      reg.addVersion(version("x", "CO", new Date(0), rules(100_000_000_000n))),
    ).toThrow();
  });
});

describe("ComplianceService", () => {
  const setup = () => {
    const reg = new RuleSetRegistry();
    reg.addVersion(version("v1", "US-CA", new Date(0)));
    const queue = new InMemoryReviewQueue();
    const clock = manualClock(new Date("2025-01-01T00:00:00Z"));
    return { svc: new ComplianceService(reg, queue, clock), queue };
  };
  const goodDoc = { license: "state_raffle_license", file: { size: 10, mime: "application/pdf" } };

  it("is ok with full US evidence", () => {
    const { svc } = setup();
    const r = svc.requestPublication("r1", "v1", subject, {
      eligibilityDeclared: true,
      documents: [goodDoc],
    });
    expect(r.status).toBe("ok");
  });

  it("queues pending_review when evidence is missing", () => {
    const { svc, queue } = setup();
    const r = svc.requestPublication("r1", "v1", subject, { documents: [] });
    expect(r.status).toBe("pending_review");
    expect(queue.entries).toHaveLength(1);
  });

  it("blocks on violations without queueing", () => {
    const { svc, queue } = setup();
    const r = svc.requestPublication(
      "r1",
      "v1",
      { ...subject, raffleType: "x" },
      { documents: [] },
    );
    expect(r.status).toBe("blocked");
    expect(queue.entries).toHaveLength(0);
  });

  it("requires authorization number and document for Colombia", () => {
    const reg = new RuleSetRegistry();
    reg.addVersion(
      version("co1", "CO", new Date(0), {
        ...rules(),
        maxPrize: { amountMinor: 10n ** 10n, currency: "COP" },
      }),
    );
    const svc = new ComplianceService(reg, new InMemoryReviewQueue(), manualClock(new Date(0)));
    const s = {
      ...subject,
      jurisdiction: "CO",
      prizeValue: { amountMinor: 1n, currency: "COP" as const },
    };
    expect(svc.requestPublication("r", "co1", s, { documents: [] }).status).toBe("pending_review");
    const full = {
      authorizationNumber: "A-1",
      documents: [{ license: "authorization", file: { size: 1, mime: "image/jpeg" } }],
    };
    expect(svc.requestPublication("r", "co1", s, full).status).toBe("ok");
  });
});

describe("helpers", () => {
  it("ageOn counts whole years", () => {
    expect(ageOn(new Date("2000-06-15T00:00:00Z"), new Date("2018-06-14T00:00:00Z"))).toBe(17);
    expect(ageOn(new Date("2000-06-15T00:00:00Z"), new Date("2018-06-15T00:00:00Z"))).toBe(18);
  });
  it("disclosures include minimum set plus rule set items", () => {
    const d = requiredDisclosures(rules(), {
      ownerIdentity: "o",
      licenseNumber: "l",
      prizeDescription: "p",
      drawMethod: "m",
    });
    expect(d.map((x) => x.key)).toEqual([
      "ownerIdentity",
      "licenseNumber",
      "prizeDescription",
      "drawMethod",
      "odds",
    ]);
  });
});

describe("DocumentService", () => {
  it("marks failed, notifies admin, retries 3 times at 5-minute intervals", async () => {
    const clock = manualClock(new Date(0));
    let calls = 0;
    const notified: string[] = [];
    const svc = new DocumentService(
      clock,
      async () => {
        calls += 1;
        throw new Error("boom");
      },
      (d) => notified.push(d.id),
    );
    const doc = await svc.request("d1", "tax_report", "r1");
    expect(doc.status).toBe("failed");
    expect(notified).toEqual(["d1"]);
    expect(doc.nextRetryAt?.getTime()).toBe(300_000);
    await svc.runDueRetries();
    expect(calls).toBe(1); // not due yet
    for (let i = 0; i < 5; i++) {
      clock.advance(300_000);
      await svc.runDueRetries();
    }
    expect(calls).toBe(4); // initial + 3 retries
    expect(svc.get("d1")?.nextRetryAt).toBeNull();
  });

  it("succeeds on a retry", async () => {
    const clock = manualClock(new Date(0));
    let n = 0;
    const svc = new DocumentService(
      clock,
      async () => {
        n += 1;
        if (n === 1) throw new Error("x");
      },
      () => undefined,
    );
    await svc.request("d", "payout_summary", "r");
    clock.advance(300_000);
    await svc.runDueRetries();
    expect(svc.get("d")?.status).toBe("generated");
  });
});
