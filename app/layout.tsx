import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aura — Visual Scribe",
  description: "A multimodal medical scribe interface prototype. Synthetic demo only.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
