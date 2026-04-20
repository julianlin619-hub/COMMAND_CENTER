/**
 * Root Layout — the outermost wrapper for every page in the app.
 *
 * Forces dark mode via the `dark` class on <html>. All pages share
 * a persistent top navigation bar with links and the Clerk user button.
 */

import type { Metadata } from "next";
import { DM_Sans, JetBrains_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

/* Humanist UI sans + mono for numeric/technical data — picked up everywhere
   via Tailwind's `font-sans` / `font-mono` classes (see --font-geist-* in
   globals.css which now prefer these variables). */
const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-dm",
});
const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono-brand",
});

export const metadata: Metadata = {
  title: "Command Center",
  description: "Social media automation dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark h-full antialiased ${dmSans.variable} ${jetBrainsMono.variable}`}
    >
      <body className="min-h-full bg-background text-foreground">
        <ClerkProvider appearance={{ baseTheme: dark }}>
          <TooltipProvider delay={300}>
            {children}
          </TooltipProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
