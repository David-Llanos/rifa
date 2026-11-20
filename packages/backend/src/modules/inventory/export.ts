import { err, ok, systemClock, toCsv } from "@raffle/shared";
import type { Clock, Result } from "@raffle/shared";
import type { InventoryRepository } from "./repository.js";
import type { TicketListRow } from "./types.js";

/** Exports of up to 100,000 tickets must finish within 30 seconds (Req 4.6, 4.7). */
export const EXPORT_TIMEOUT_MS = 30_000;

export const TICKET_CSV_HEADER = ["number", "status", "buyer_name", "purchased_at"] as const;

export type TicketListError = { kind: "not_found" };

export type ExportError =
  | { kind: "not_found" }
  /** The export failed or exceeded the time limit. Nothing was written: the export only reads. */
  | { kind: "export_failed"; reason: "timeout" | "error" };

export interface TicketCsvExport {
  filename: string;
  contentType: "text/csv; charset=utf-8";
  body: string;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface TicketExportDeps<Tx> {
  repo: InventoryRepository<Tx>;
  clock?: Clock;
  timers?: Timers;
  timeoutMs?: number;
}

export interface TicketExportService {
  /** The Owner's ticket list (Req 4.5). */
  ticketList(raffleId: string): Promise<Result<TicketListRow[], TicketListError>>;
  /** CSV with the same fields as the ticket list (Req 4.6); fails cleanly on timeout or error (Req 4.7). */
  exportCsv(raffleId: string): Promise<Result<TicketCsvExport, ExportError>>;
}

/**
 * Spreadsheet apps run cells starting with these characters as formulas. Buyer names are user input,
 * so such values get a leading apostrophe (OWASP CSV injection guidance).
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

export function ticketRowsToCsv(rows: readonly TicketListRow[]): string {
  return toCsv([
    TICKET_CSV_HEADER,
    ...rows.map((r) => [
      String(r.number),
      r.status,
      r.buyerName === null ? "" : neutralizeFormula(r.buyerName),
      r.purchasedAt === null ? "" : r.purchasedAt.toISOString(),
    ]),
  ]);
}

class ExportTimeout extends Error {}

export function createTicketExportService<Tx>(deps: TicketExportDeps<Tx>): TicketExportService {
  const { repo } = deps;
  const clock = deps.clock ?? systemClock;
  const timers = deps.timers ?? defaultTimers;
  const timeoutMs = deps.timeoutMs ?? EXPORT_TIMEOUT_MS;

  function load(raffleId: string): Promise<TicketListRow[] | null> {
    return repo.transaction(async (tx) => {
      if (!(await repo.getRaffleShared(tx, raffleId))) return null;
      return repo.listTickets(tx, raffleId);
    });
  }

  return {
    async ticketList(raffleId) {
      const rows = await load(raffleId);
      return rows ? ok(rows) : err({ kind: "not_found" });
    },

    async exportCsv(raffleId) {
      const started = clock.now().getTime();
      let handle: unknown = null;
      const timeout = new Promise<never>((_, reject) => {
        handle = timers.setTimeout(() => reject(new ExportTimeout()), timeoutMs);
      });
      try {
        const rows = await Promise.race([load(raffleId), timeout]);
        if (!rows) return err({ kind: "not_found" });
        const body = ticketRowsToCsv(rows);
        // Serialization is synchronous, so check the limit again once it is done.
        if (clock.now().getTime() - started > timeoutMs) {
          return err({ kind: "export_failed", reason: "timeout" });
        }
        return ok({
          filename: `raffle-${raffleId}-tickets.csv`,
          contentType: "text/csv; charset=utf-8",
          body,
        });
      } catch (e) {
        return err({
          kind: "export_failed",
          reason: e instanceof ExportTimeout ? "timeout" : "error",
        });
      } finally {
        timers.clearTimeout(handle);
      }
    },
  };
}
