"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Locale, Money } from "@raffle/shared";
import { LOCALE_COOKIE, LocalePreferenceController, type SaveStatus } from "./locale-preference";
import { createTranslator, type Translate } from "./translate";
import { formatMoney } from "./format";
import { pickContent, type BilingualField } from "./content";

interface I18nContextValue {
  locale: Locale;
  t: Translate;
  formatMoney: (m: Money) => string;
  pick: (field: BilingualField) => string | undefined;
  setLocale: (locale: Locale) => void;
  saveStatus: SaveStatus;
  retrySave: () => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function writeCookie(locale: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
}

/**
 * Provides the Locale to the tree. Switching updates state in place (no remount), so
 * unsubmitted form input and scroll position are preserved (Requirement 20.3).
 * `saveLocale` persists to the user profile; omit it for anonymous visitors.
 */
export function I18nProvider({
  initialLocale,
  saveLocale,
  children,
}: {
  initialLocale: Locale;
  saveLocale?: (locale: Locale) => Promise<void>;
  children: ReactNode;
}) {
  const saveRef = useRef(saveLocale);
  saveRef.current = saveLocale;
  const controller = useMemo(
    () =>
      new LocalePreferenceController(initialLocale, async (l) => {
        writeCookie(l);
        await saveRef.current?.(l);
      }),
    [], // created once; initialLocale is only the starting value
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const reported = useRef(new Set<string>()).current;

  useEffect(() => {
    document.documentElement.lang = state.locale;
  }, [state.locale]);

  const value = useMemo<I18nContextValue>(() => {
    const locale = state.locale;
    return {
      locale,
      t: createTranslator(locale, { reported }),
      formatMoney: (m) => formatMoney(m, locale),
      pick: (field) => pickContent(field, locale),
      setLocale: (l) => void controller.select(l),
      saveStatus: state.saveStatus,
      retrySave: () => void controller.retry(),
    };
  }, [state, controller, reported]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}
