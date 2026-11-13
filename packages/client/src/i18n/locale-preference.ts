import type { Locale } from "@raffle/shared";

export const LOCALE_COOKIE = "locale";

export type SaveStatus = "idle" | "saved" | "failed";

export interface LocalePreferenceState {
  locale: Locale;
  saveStatus: SaveStatus;
}

/**
 * Holds the selected Locale. A selection applies immediately (Requirement 20.3). It is then
 * persisted to the user profile; on failure the Locale stays selected for the session and the
 * status becomes "failed" so the UI can show an error and offer retry (Requirement 20.4).
 */
export class LocalePreferenceController {
  private state: LocalePreferenceState;
  private readonly listeners = new Set<() => void>();

  constructor(
    initial: Locale,
    private readonly save: (locale: Locale) => Promise<void>,
  ) {
    this.state = { locale: initial, saveStatus: "idle" };
  }

  getState = (): LocalePreferenceState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: LocalePreferenceState): void {
    this.state = next;
    this.listeners.forEach((l) => l());
  }

  /** Apply the Locale synchronously, then persist it. Resolves true when saved. */
  select(locale: Locale): Promise<boolean> {
    this.set({ locale, saveStatus: "idle" });
    return this.persist(locale);
  }

  /** Retry saving the currently selected Locale after a failure. */
  retry(): Promise<boolean> {
    return this.persist(this.state.locale);
  }

  private async persist(locale: Locale): Promise<boolean> {
    let ok = true;
    try {
      await this.save(locale);
    } catch {
      ok = false;
    }
    // Ignore stale results if the user switched again meanwhile.
    if (this.state.locale === locale) {
      this.set({ locale, saveStatus: ok ? "saved" : "failed" });
    }
    return ok;
  }
}
