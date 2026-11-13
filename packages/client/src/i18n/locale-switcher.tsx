"use client";

import { LOCALES } from "@raffle/shared";
import { useI18n } from "./provider";

export function LocaleSwitcher() {
  const { locale, t, setLocale, saveStatus, retrySave } = useI18n();
  return (
    <div>
      <label htmlFor="locale-select">{t("locale.label")}</label>{" "}
      <select
        id="locale-select"
        value={locale}
        onChange={(e) => setLocale(e.target.value as (typeof LOCALES)[number])}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {t(`locale.${l}`)}
          </option>
        ))}
      </select>
      {saveStatus === "failed" && (
        <p role="alert">
          {t("locale.saveFailed")}{" "}
          <button type="button" onClick={retrySave}>
            {t("locale.retry")}
          </button>
        </p>
      )}
    </div>
  );
}
