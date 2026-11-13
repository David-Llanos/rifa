/**
 * Notification_Service pure core.
 * Requirements 10.2, 10.3, 10.4, 10.6, 10.7, 10.8, 10.9, 11.3, 11.5, 11.6, 11.8, 11.10.
 */
import { DEFAULT_LOCALE } from "@raffle/shared";
import type { Locale } from "@raffle/shared";

export type Channel = "email" | "sms" | "push";

export const NOTIFICATION_TYPES = [
  "account_verification",
  "account_security",
  "purchase_receipt",
  "reservation_expiry",
  "payment_failure",
  "refund",
  "deadline_reminder",
  "sales_milestone",
  "winner_announcement",
  "raffle_status_change",
  "payout",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Mandatory types ignore preference changes (Requirement 11.3). Verification is part of account security. */
export const MANDATORY_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
  "account_verification",
  "account_security",
  "purchase_receipt",
  "refund",
  "winner_announcement",
]);

export function isMandatory(type: NotificationType): boolean {
  return MANDATORY_TYPES.has(type);
}

export type Prefs = Partial<Record<NotificationType, Partial<Record<Channel, boolean>>>>;

export interface Contact {
  /** Valid, deliverable email address, if any. */
  email?: string | undefined;
  /** Valid E.164 phone number, if any. */
  phone?: string | undefined;
  /** True when the recipient has an active web push subscription. */
  pushSubscribed?: boolean | undefined;
  /** True after the recipient replied STOP or PARAR (blocks non-mandatory SMS). */
  smsOptedOut?: boolean | undefined;
}

/** Recipient locale: profile locale when present, else the raffle default (Requirements 10.8, 10.9). */
export function resolveLocale(
  profile: Locale | undefined,
  raffleDefault: Locale | undefined,
): Locale {
  return profile ?? raffleDefault ?? DEFAULT_LOCALE;
}

function hasContact(channel: Channel, contact: Contact): boolean {
  switch (channel) {
    case "email":
      return !!contact.email && contact.email.length > 0;
    case "sms":
      return !!contact.phone && contact.phone.length > 0;
    case "push":
      return contact.pushSubscribed === true;
  }
}

const CHANNEL_ORDER: readonly Channel[] = ["email", "sms", "push"];

/**
 * Channels to use for a notification. Optional types go only to channels the user
 * enabled and has a contact for (and not SMS-opted-out). Mandatory types ignore
 * opt-outs and use at least one email or SMS channel with a valid contact.
 */
export function channelsFor(type: NotificationType, prefs: Prefs, contact: Contact): Channel[] {
  const enabled = (c: Channel): boolean => prefs[type]?.[c] === true;
  if (!isMandatory(type)) {
    return CHANNEL_ORDER.filter(
      (c) => enabled(c) && hasContact(c, contact) && !(c === "sms" && contact.smsOptedOut === true),
    );
  }
  const preferred = (["email", "sms"] as const).filter((c) => enabled(c) && hasContact(c, contact));
  if (preferred.length > 0) return preferred;
  const fallback = (["email", "sms"] as const).find((c) => hasContact(c, contact));
  return fallback ? [fallback] : [];
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const ALLOWED_PLACEHOLDERS = [
  "player_name",
  "ticket_numbers",
  "raffle_title",
  "deadline",
  "winning_number",
] as const;
export type Placeholder = (typeof ALLOWED_PLACEHOLDERS)[number];

const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;

/** Placeholder syntax is `{{name}}`; surrounding whitespace inside the braces is ignored. */
export function parseTemplate(src: string): { placeholders: Set<string> } | { unknown: string[] } {
  const found = new Set<string>();
  const unknown: string[] = [];
  for (const m of src.matchAll(PLACEHOLDER_RE)) {
    const name = (m[1] ?? "").trim();
    found.add(name);
    if (!(ALLOWED_PLACEHOLDERS as readonly string[]).includes(name) && !unknown.includes(name)) {
      unknown.push(name);
    }
  }
  return unknown.length > 0 ? { unknown } : { placeholders: found };
}

/** Single-pass substitution; substituted values are never re-interpreted. Missing values render empty. */
export function renderTemplate(src: string, values: Record<string, string>): string {
  return src.replace(PLACEHOLDER_RE, (_all, raw: string) => {
    const name = raw.trim();
    return Object.prototype.hasOwnProperty.call(values, name) ? (values[name] ?? "") : "";
  });
}

// ---------------------------------------------------------------------------
// SMS
// ---------------------------------------------------------------------------

const GSM7_BASIC = new Set(
  Array.from(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
  ),
);
/** GSM 03.38 extension table characters cost 2 septets. */
const GSM7_EXT = new Set(Array.from("\f^{}\\[~]|€"));

/** Number of SMS segments for the text (GSM-7: 160/153, UCS-2: 70/67). Empty text is 0. */
export function smsSegments(text: string): number {
  if (text.length === 0) return 0;
  let septets = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM7_BASIC.has(ch)) septets += 1;
    else if (GSM7_EXT.has(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return septets <= 160 ? 1 : Math.ceil(septets / 153);
  const units = text.length; // UTF-16 code units
  return units <= 70 ? 1 : Math.ceil(units / 67);
}

/** STOP / PARAR, case-insensitive, ignoring surrounding whitespace (Requirement 11.10). */
export function isStopKeyword(body: string): boolean {
  const k = body.trim().toLowerCase();
  return k === "stop" || k === "parar";
}

// ---------------------------------------------------------------------------
// Delivery plan
// ---------------------------------------------------------------------------

export const RETRY_INTERVAL_SECONDS = 60;
export const MAX_RETRIES = 3;

export interface ChannelAttemptLog {
  /** Failed attempts on the primary channel, including the initial attempt. */
  primaryFailures: number;
  /** Attempts made on the alternate channel. */
  alternateAttempts: number;
}

/**
 * Next step after failures: retry the same channel up to 3 times (initial attempt
 * plus 3 retries), then one attempt on the consented alternate channel, else undelivered.
 */
export function deliveryPlan(
  failures: ChannelAttemptLog,
  consentAlt: Channel | null,
): "retry" | "alternate" | "undelivered" {
  if (failures.primaryFailures < 1 + MAX_RETRIES) return "retry";
  if (consentAlt !== null && failures.alternateAttempts < 1) return "alternate";
  return "undelivered";
}

// ---------------------------------------------------------------------------
// Winner message
// ---------------------------------------------------------------------------

export interface WinnerRaffle {
  title: { en?: string; es?: string };
  defaultLocale: Locale;
  shareUrl: string;
}

export interface WinnerInfo {
  ticket: number | string;
  name: string;
  email?: string | undefined;
  phone?: string | undefined;
}

export interface Message {
  locale: Locale;
  subject: string;
  body: string;
}

function titleFor(raffle: WinnerRaffle, locale: Locale): string {
  return (
    raffle.title[locale] ??
    raffle.title[raffle.defaultLocale] ??
    raffle.title.en ??
    raffle.title.es ??
    ""
  );
}

/**
 * Role-specific winner message. Owner gets ticket, name and contact data; the winner gets
 * ticket and a won statement; others get ticket and share link and never the winner's identity.
 */
export function winnerMessage(
  role: "owner" | "winner" | "other",
  raffle: WinnerRaffle,
  winner: WinnerInfo,
  locale: Locale,
): Message {
  const title = titleFor(raffle, locale);
  const ticket = String(winner.ticket);
  const es = locale === "es";
  const subject = es ? `Ganador de la rifa: ${title}` : `Winner announced: ${title}`;
  let body: string;
  switch (role) {
    case "owner": {
      const contact = [winner.email, winner.phone].filter((v): v is string => !!v).join(", ");
      body = es
        ? `La rifa "${title}" tiene ganador. Boleto ganador: ${ticket}. Nombre: ${winner.name}. Contacto: ${contact}.`
        : `Raffle "${title}" has a winner. Winning ticket: ${ticket}. Name: ${winner.name}. Contact: ${contact}.`;
      break;
    }
    case "winner":
      body = es
        ? `¡Felicidades! Ganaste la rifa "${title}" con el boleto ${ticket}.`
        : `Congratulations! You won the raffle "${title}" with ticket ${ticket}.`;
      break;
    case "other":
      body = es
        ? `El boleto ganador de la rifa "${title}" es el ${ticket}. Más detalles: ${raffle.shareUrl}`
        : `The winning ticket for raffle "${title}" is ${ticket}. Details: ${raffle.shareUrl}`;
      break;
  }
  return { locale, subject, body };
}
