import type { ReactNode } from "react";
import { DEFAULT_LOCALE } from "@raffle/shared";

export const metadata = {
  title: "Raffle Platform",
  description: "Create and join raffles tied to official lottery draws.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={DEFAULT_LOCALE}>
      <body>{children}</body>
    </html>
  );
}
