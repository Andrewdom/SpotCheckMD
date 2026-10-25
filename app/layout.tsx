import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Spot Check MD — Clinical Workspace",
  description: "A physician-reviewed multimodal documentation research prototype. Synthetic demonstration only.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
