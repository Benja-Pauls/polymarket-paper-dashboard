import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Polymarket Paper Dashboard",
  description:
    "Paper-money tracker for Polymarket prediction-market trading strategies. NO real money is ever at risk.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <header className="border-b border-border/60 bg-background/80 backdrop-blur sticky top-0 z-30">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
            <Link href="/" className="flex items-center gap-3 font-medium">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground font-mono text-xs">
                PM
              </span>
              <span className="text-base">Paper Dashboard</span>
              <span className="ml-2 hidden rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground sm:inline">
                paper · no real money
              </span>
            </Link>
            <a
              href="https://github.com/Benja-Pauls/polymarket-paper-dashboard"
              target="_blank"
              rel="noreferrer"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              github
            </a>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
        <footer className="border-t border-border/60 px-6 py-4 text-xs text-muted-foreground">
          <div className="mx-auto flex max-w-6xl items-center justify-between">
            <span className="font-mono">tighter_blanket_cap10_3day · paper-money only</span>
            <span>v0 · read-only</span>
          </div>
        </footer>
        <Toaster />
      </body>
    </html>
  );
}
