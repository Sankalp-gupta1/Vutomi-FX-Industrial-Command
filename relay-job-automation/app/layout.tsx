import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "relay. | Job operations",
  description: "Create, run, and understand automated jobs.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
