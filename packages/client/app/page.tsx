"use client";

import { LocaleSwitcher } from "../src/i18n/locale-switcher";
import { useI18n } from "../src/i18n/provider";

export default function HomePage() {
  const { t } = useI18n();
  return (
    <main>
      <LocaleSwitcher />
      <h1>{t("home.heading")}</h1>
      <p>{t("home.tagline")}</p>
    </main>
  );
}
