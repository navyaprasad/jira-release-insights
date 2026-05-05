import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jira release notes — multi-agent",
  description: "Fetcher, Analyzer, Writer, and QA agents with Jira MCP",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
