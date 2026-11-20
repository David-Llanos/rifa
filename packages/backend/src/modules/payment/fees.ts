import { CURRENCIES, err, money, ok, sum } from "@raffle/shared";
import type { Currency, Money, Result } from "@raffle/shared";

/** Paid customization options (Requirement 3.5). */
export const CUSTOMIZATION_OPTIONS = [
  "branding",
  "share_theme",
  "extra_prize_images",
  "notification_templates",
] as const;
export type CustomizationOption = (typeof CUSTOMIZATION_OPTIONS)[number];

export type FeeItem = "creation_fee" | CustomizationOption;

export function isCustomizationOption(v: unknown): v is CustomizationOption {
  return typeof v === "string" && (CUSTOMIZATION_OPTIONS as readonly string[]).includes(v);
}

/** A fee in minor units for every supported currency. */
export type CurrencyAmounts = Readonly<Record<Currency, bigint>>;

export interface FeeSchedule {
  readonly creation: CurrencyAmounts;
  readonly customization: Readonly<Record<CustomizationOption, CurrencyAmounts>>;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function hasExactKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(v);
  return (
    own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k))
  );
}

/** `{ "COP": <int >= 0>, "USD": <int >= 0> }`, as stored in `platform_config` (JSON numbers). */
export function isCurrencyAmountsConfig(v: unknown): boolean {
  return (
    isPlainObject(v) &&
    hasExactKeys(v, CURRENCIES) &&
    CURRENCIES.every((c) => Number.isSafeInteger(v[c]) && (v[c] as number) >= 0)
  );
}

/** One `CurrencyAmounts` config per customization option, and no other keys. */
export function isCustomizationFeesConfig(v: unknown): boolean {
  return (
    isPlainObject(v) &&
    hasExactKeys(v, CUSTOMIZATION_OPTIONS) &&
    CUSTOMIZATION_OPTIONS.every((o) => isCurrencyAmountsConfig(v[o]))
  );
}

function toAmounts(v: Record<string, unknown>): CurrencyAmounts {
  return { COP: BigInt(v["COP"] as number), USD: BigInt(v["USD"] as number) };
}

export type FeeConfigError = { readonly code: "fee_config_invalid" };

/** Parses the `fee.creation_minor` and `fee.customization_minor` config values. */
export function parseFeeSchedule(
  creation: unknown,
  customization: unknown,
): Result<FeeSchedule, FeeConfigError> {
  if (!isCurrencyAmountsConfig(creation) || !isCustomizationFeesConfig(customization)) {
    return err({ code: "fee_config_invalid" });
  }
  const c = customization as Record<string, Record<string, unknown>>;
  return ok({
    creation: toAmounts(creation as Record<string, unknown>),
    customization: {
      branding: toAmounts(c["branding"]!),
      share_theme: toAmounts(c["share_theme"]!),
      extra_prize_images: toAmounts(c["extra_prize_images"]!),
      notification_templates: toAmounts(c["notification_templates"]!),
    },
  });
}

/** The fee for one item in the raffle currency. */
export function feeFor(schedule: FeeSchedule, item: FeeItem, currency: Currency): Money {
  const amounts = item === "creation_fee" ? schedule.creation : schedule.customization[item];
  return money(amounts[currency], currency);
}

export interface FeeLine {
  readonly item: FeeItem;
  readonly amount: Money;
}

export interface FeeQuote {
  readonly lines: readonly FeeLine[];
  /** Always the sum of the lines (Requirement 3.1, Property 7). */
  readonly total: Money;
}

/** Lines in a stable order: the Creation_Fee first, then options in catalog order. */
export function quoteFees(
  schedule: FeeSchedule,
  currency: Currency,
  items: readonly FeeItem[],
): FeeQuote {
  const wanted = new Set(items);
  const ordered: FeeItem[] = (["creation_fee", ...CUSTOMIZATION_OPTIONS] as const).filter((i) =>
    wanted.has(i),
  );
  const lines = ordered.map((item) => ({ item, amount: feeFor(schedule, item, currency) }));
  return {
    lines,
    total: sum(
      lines.map((l) => l.amount),
      currency,
    ),
  };
}
