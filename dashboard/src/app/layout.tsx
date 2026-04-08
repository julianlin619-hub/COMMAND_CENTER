/**
 * Root Layout — the outermost wrapper for every page in the app.
 *
 * Forces dark mode via the `dark` class on <html>. All pages share
 * a persistent top navigation bar with links and the Clerk user button.
 */

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
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
