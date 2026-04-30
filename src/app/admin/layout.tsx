// Shared layout for /admin pages. Adds a sub-nav so operators can move
// between the admin views without going back to the home page.

import Link from "next/link";

export const metadata = {
  title: "Admin · Polymarket Paper Dashboard",
};

const ADMIN_LINKS = [
  { href: "/admin/crons", label: "Crons" },
  { href: "/admin/edge-rate", label: "Edge Rate" },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 z-10 bg-background/90 backdrop-blur">
        <div className="mx-auto max-w-7xl px-6 py-3 flex items-center gap-6">
          <Link href="/" className="font-semibold text-sm hover:underline">
            ← Dashboard
          </Link>
          <nav className="flex gap-4 text-sm">
            {ADMIN_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-muted-foreground hover:text-foreground"
              >
                {l.label}
              </Link>
            ))}
          </nav>
          <span className="ml-auto text-xs text-muted-foreground">
            All times: America/Chicago (CST/CDT)
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">{children}</main>
    </div>
  );
}
