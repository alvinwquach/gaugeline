import { SanityLive } from "@/sanity/live";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <SanityLive refreshOnFocus={false} />
      </body>
    </html>
  );
}
