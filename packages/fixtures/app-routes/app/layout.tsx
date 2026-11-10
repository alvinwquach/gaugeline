import { cookies } from "next/headers";
import type { ReactNode } from "react";

// The navigation shows "Sign in" or "My account". Every page is wrapped by this layout, public ones too.
export default async function RootLayout({ children }: { children: ReactNode }) {
  const signedIn = (await cookies()).has("fernbank_session");
  return (
    <html lang="en">
      <body>
        <nav>{signedIn ? "My account" : "Sign in"}</nav>
        {children}
      </body>
    </html>
  );
}
