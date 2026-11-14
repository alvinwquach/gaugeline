export const metadata = {
  title: "Harbour Bar",
  robots: { index: process.env.SITE_INDEXING === "true" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
