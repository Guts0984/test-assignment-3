import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { BookingsProvider } from "@/features/booking";
import { SiteHeader } from "./_components/site-header";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Event Tickets", template: "%s · Event Tickets" },
  description: "Find an event, hold your seats, confirm your booking.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <BookingsProvider>
          <SiteHeader />
          {children}
        </BookingsProvider>
      </body>
    </html>
  );
}
