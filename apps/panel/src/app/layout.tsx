import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { getSessionUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Deers Server Hosting",
  description: "Minecraft and game server hosting you can actually control.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  const nav = user
    ? [
        { href: "/servers", label: "Servers" },
        { href: "/plans", label: "Plans" },
        { href: "/billing", label: "Billing" },
      ]
    : [];

  const adminNav =
    user?.role === "ADMIN"
      ? [
          { href: "/admin/nodes", label: "Nodes" },
          { href: "/admin/servers", label: "All servers" },
          { href: "/admin/alerts", label: "Alerts" },
          { href: "/admin/logs", label: "Activity" },
        ]
      : [];

  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen">
        <header className="sticky top-0 z-20 border-b border-line-soft bg-bg/85 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-6 px-5 py-3">
            <Link href="/" className="font-display text-lg font-bold tracking-tight text-gold">
              Deers
            </Link>

            {nav.length > 0 && (
              <nav className="flex gap-4 text-sm">
                {nav.map((item) => (
                  <Link key={item.href} href={item.href} className="text-muted hover:text-text">
                    {item.label}
                  </Link>
                ))}
              </nav>
            )}

            {adminNav.length > 0 && (
              <nav className="hidden gap-4 border-l border-line pl-6 text-sm md:flex">
                {adminNav.map((item) => (
                  <Link key={item.href} href={item.href} className="text-muted hover:text-text">
                    {item.label}
                  </Link>
                ))}
              </nav>
            )}

            {user && (
              <div className="ml-auto flex items-center gap-3 text-sm">
                <span className="hidden text-muted sm:inline">{user.displayName}</span>
                <form action="/api/auth/logout" method="post">
                  <button className="text-muted hover:text-text">Sign out</button>
                </form>
              </div>
            )}
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-5 py-8">{children}</main>
      </body>
    </html>
  );
}
