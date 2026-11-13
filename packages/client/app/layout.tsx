import type { ReactNode } from "react";
import { cookies, headers } from "next/headers";
import { isLocale } from "@raffle/shared";
import { detectLocale, parseAcceptLanguage } from "../src/i18n/detect";
import { LOCALE_COOKIE } from "../src/i18n/locale-preference";
import { createTranslator } from "../src/i18n/translate";
import { I18nProvider } from "../src/i18n/provider";

async function resolveLocale() {
  const stored = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(stored)) return stored;
  return detectLocale(parseAcceptLanguage((await headers()).get("accept-language")));
}

export async function generateMetadata() {
  const t = createTranslator(await resolveLocale());
  return { title: t("app.title"), description: t("app.description") };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await resolveLocale();
  return (
    <html lang={locale}>
      <body>
        <I18nProvider initialLocale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
