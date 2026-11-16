import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Squishy Shop",
  description: "Squishy Shop stok, satış ve kasa paneli",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
