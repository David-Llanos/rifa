import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { isLocale } from "@raffle/shared";
import { detectLocale, parseAcceptLanguage } from "../src/i18n/detect";
import { LOCALE_COOKIE } from "../src/i18n/locale-preference";
import { createTranslator } from "../src/i18n/translate";
import { I18nProvider } from "../src/i18n/provider";
import { PwaProvider } from "../src/pwa/pwa-provider";
import "./globals.css";

async function resolveLocale() {
  const stored = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(stored)) return stored;
  return detectLocale(parseAcceptLanguage((await headers()).get("accept-language")));
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1d4ed8",
};

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator(await resolveLocale());
  return {
    title: t("app.title"),
    description: t("app.description"),
    manifest: "/manifest.webmanifest",
    icons: { icon: "/icon.svg", apple: "/icon.svg" },
    appleWebApp: { capable: true, title: t("app.title") },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await resolveLocale();
  return (
    <html lang={locale}>
      <body>
        <I18nProvider initialLocale={locale}>
          <PwaProvider>{children}</PwaProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
