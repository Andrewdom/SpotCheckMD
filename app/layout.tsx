import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aura — Clinical Workspace",
  description: "A physician-reviewed multimodal clinical documentation workspace.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
