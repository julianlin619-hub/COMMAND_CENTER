/**
 * Root Layout — the outermost wrapper for every page in the app.
 *
 * Forces dark mode via the `dark` class on <html>. All pages share
 * a persistent top navigation bar with links and the Clerk user button.
 */

import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

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
      className="dark h-full antialiased"
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
