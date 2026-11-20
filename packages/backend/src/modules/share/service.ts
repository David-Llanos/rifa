import {
  DEFAULT_LOCALE,
  systemClock,
  type Clock,
  type CryptoRng,
  type Locale,
} from "@raffle/shared";
import type { DisclosureItem, RuleSetRules } from "../compliance/types.js";
import { requiredDisclosures } from "../compliance/rules.js";
import { shareLotteryInfo, type ShareLotteryInfo } from "../raffle/lottery-catalog.js";
import type { Raffle, RaffleStatus } from "../raffle/types.js";
import {
  defaultOgImageResolver,
  ogTags,
  pickText,
  type OgImageResolver,
  type OgTags,
} from "./metadata.js";
import { qrEncode, type QrFormat } from "./qr.js";
import { generateShareToken, isWellFormedShareToken, shareUrl } from "./token.js";

/** The countdown refreshes at least once per second (Requirement 16.5). */
export const COUNTDOWN_TICK_MS = 1000;
/** Availability and winner results refresh within 5 seconds (Requirements 16.5, 16.4). */
export const AVAILABILITY_REFRESH_MS = 5000;
export const TOKEN_ASSIGN_ATTEMPTS = 5;

/**
 * Statuses whose Share_Page is public. Draft and pending_review raffles have never been
 * published, so they answer exactly like a missing raffle (Requirement 16.9).
 */
export const PUBLIC_STATUSES: readonly RaffleStatus[] = [
  "published",
  "sales_closed",
  "awaiting_draw",
  "completed",
  "cancelled",
];

export interface Branding {
  logoUrl: string;
  primaryColor: string;
  secondaryColor: string;
}

export interface ShareRecord {
  raffle: Raffle;
  shareToken: string | null;
  /** Present only when the Owner purchased the custom branding option (Requirement 16.10). */
  branding: Branding | null;
}

export interface ShareRepository {
  findByToken(token: string): Promise<ShareRecord | null>;
  findById(raffleId: string): Promise<ShareRecord | null>;
  /** Sets the token if none is set; "collision" when the unique index rejects it. */
  assignToken(raffleId: string, token: string): Promise<"assigned" | "collision" | "already_set">;
}

export interface WinnerResult {
  winnerTicket: number;
  /** "First L." when the winner consented, otherwise null (Requirement 20.x privacy). */
  winnerDisplayName: string | null;
  announcedAt: Date;
}

export interface ShareContext {
  availableTickets: number;
  ownerName: string;
  rules: RuleSetRules;
  disclosureFacts: {
    ownerIdentity: string;
    licenseNumber: string;
    prizeDescription: string;
    drawMethod: string;
  };
  winner: WinnerResult | null;
}

export interface ShareContextSource {
  load(raffle: Raffle): Promise<ShareContext>;
}

export interface MoneyView {
  amountMinor: string;
  currency: string;
}

export interface SharePage {
  token: string;
  url: string;
  locale: Locale;
  status: RaffleStatus;
  title: string;
  description: string;
  prizeImages: string[];
  prizeValue: MoneyView;
  ticketPrice: MoneyView;
  tickets: { total: number; available: number };
  deadline: { at: string; tz: string; msRemaining: number };
  lottery: ShareLotteryInfo;
  owner: { name: string };
  disclosures: DisclosureItem[];
  branding: Branding | null;
  winner: { ticket: number; displayName: string | null; announcedAt: string } | null;
  refresh: { countdownMs: number; availabilityMs: number };
  /** Full content is public; no sign-in is needed to view (Requirement 16.7). */
  requiresSignIn: false;
  og: OgTags;
}

export interface ShareResponse {
  status: 200 | 404;
  /** Dynamic data must not be cached, so availability and winner stay within 5 seconds. */
  cacheControl: "no-store";
  body: SharePage | NotFoundPage;
}

export interface NotFoundPage {
  kind: "not_found";
  messageKey: "share.unavailable";
}

/** The single not-found body used for missing, malformed and unpublished raffles (Req 16.9). */
export const NOT_FOUND_PAGE: NotFoundPage = Object.freeze({
  kind: "not_found",
  messageKey: "share.unavailable",
});

export const NOT_FOUND_RESPONSE: ShareResponse = Object.freeze({
  status: 404,
  cacheControl: "no-store",
  body: NOT_FOUND_PAGE,
});

export interface ShareDeps {
  repo: ShareRepository;
  context: ShareContextSource;
  rng: CryptoRng;
  baseUrl: string;
  clock?: Clock;
  ogImage?: OgImageResolver;
}

export type PublishShareResult =
  | { ok: true; token: string; url: string }
  | { ok: false; reason: "not_found" | "not_published" | "token_exhausted" };

export type QrDownloadResult =
  | { ok: true; body: Buffer; contentType: "image/png" | "image/svg+xml"; filename: string }
  | { ok: false; reason: "not_found" | "forbidden" | "not_published" };

export interface ShareService {
  /** Generates (once) the share token on publication; idempotent (Requirement 16.1). */
  ensureShareToken(raffleId: string): Promise<PublishShareResult>;
  /** Owner QR download in PNG or SVG (Requirements 16.2, 16.3). */
  downloadQr(ownerId: string, raffleId: string, fmt: QrFormat): Promise<QrDownloadResult>;
  /** Public page data, or the identical not-found response (Requirements 16.4 to 16.10). */
  getSharePage(token: string, locale: Locale): Promise<ShareResponse>;
}

function moneyView(minor: bigint, currency: string): MoneyView {
  return { amountMinor: minor.toString(), currency };
}

export function createShareService(deps: ShareDeps): ShareService {
  const clock = deps.clock ?? systemClock;
  const resolveImage = deps.ogImage ?? defaultOgImageResolver;

  return {
    async ensureShareToken(raffleId) {
      const rec = await deps.repo.findById(raffleId);
      if (!rec) return { ok: false, reason: "not_found" };
      if (rec.raffle.status === "draft" || rec.raffle.status === "pending_review") {
        return { ok: false, reason: "not_published" };
      }
      if (rec.shareToken) {
        return { ok: true, token: rec.shareToken, url: shareUrl(deps.baseUrl, rec.shareToken) };
      }
      for (let i = 0; i < TOKEN_ASSIGN_ATTEMPTS; i++) {
        const token = generateShareToken(deps.rng);
        const r = await deps.repo.assignToken(raffleId, token);
        if (r === "assigned") return { ok: true, token, url: shareUrl(deps.baseUrl, token) };
        if (r === "already_set") {
          const again = await deps.repo.findById(raffleId);
          if (again?.shareToken) {
            return {
              ok: true,
              token: again.shareToken,
              url: shareUrl(deps.baseUrl, again.shareToken),
            };
          }
        }
      }
      return { ok: false, reason: "token_exhausted" };
    },

    async downloadQr(ownerId, raffleId, fmt) {
      const rec = await deps.repo.findById(raffleId);
      if (!rec) return { ok: false, reason: "not_found" };
      if (rec.raffle.ownerId !== ownerId) return { ok: false, reason: "forbidden" };
      if (!rec.shareToken || !PUBLIC_STATUSES.includes(rec.raffle.status)) {
        return { ok: false, reason: "not_published" };
      }
      return {
        ok: true,
        body: qrEncode(shareUrl(deps.baseUrl, rec.shareToken), fmt),
        contentType: fmt === "png" ? "image/png" : "image/svg+xml",
        filename: `raffle-qr.${fmt}`,
      };
    },

    async getSharePage(token, locale) {
      if (!isWellFormedShareToken(token)) return NOT_FOUND_RESPONSE;
      const rec = await deps.repo.findByToken(token);
      if (!rec || rec.shareToken !== token || !PUBLIC_STATUSES.includes(rec.raffle.status)) {
        return NOT_FOUND_RESPONSE;
      }
      const raffle = rec.raffle;
      const ctx = await deps.context.load(raffle);
      const url = shareUrl(deps.baseUrl, token);
      const og = ogTags(raffle, locale, url, resolveImage);
      const currency = raffle.currency;
      const page: SharePage = {
        token,
        url,
        locale: locale ?? DEFAULT_LOCALE,
        status: raffle.status,
        title: og.title,
        description: pickText(raffle.description, locale),
        prizeImages: [...raffle.prizeImages],
        prizeValue: moneyView(raffle.prizeValueMinor, currency),
        ticketPrice: moneyView(raffle.ticketPriceMinor, currency),
        tickets: { total: raffle.totalTickets, available: ctx.availableTickets },
        deadline: {
          at: raffle.deadline.toISOString(),
          tz: raffle.tzName,
          msRemaining: Math.max(0, raffle.deadline.getTime() - clock.now().getTime()),
        },
        lottery: shareLotteryInfo(raffle),
        owner: { name: ctx.ownerName },
        disclosures: requiredDisclosures(ctx.rules, ctx.disclosureFacts),
        branding: rec.branding,
        winner: ctx.winner
          ? {
              ticket: ctx.winner.winnerTicket,
              displayName: ctx.winner.winnerDisplayName,
              announcedAt: ctx.winner.announcedAt.toISOString(),
            }
          : null,
        refresh: { countdownMs: COUNTDOWN_TICK_MS, availabilityMs: AVAILABILITY_REFRESH_MS },
        requiresSignIn: false,
        og,
      };
      return { status: 200, cacheControl: "no-store", body: page };
    },
  };
}
