import { NextResponse, type NextRequest } from "next/server";

// Patients' bookings need a sign-in: no session cookie, no page.
export function middleware(request: NextRequest) {
  if (!request.cookies.get("fernbank_session")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/appointments/:path*"] };
