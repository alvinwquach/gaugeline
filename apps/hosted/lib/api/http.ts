/** The API's answers: JSON with a stable error shape ({ code, message }) and nothing cached. */

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

export function problem(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json(status, { code, message }, headers);
}

export const UNAUTHORIZED = (): Response =>
  problem(401, "unauthorized", "Send the site's upload token as: Authorization: Bearer <token>.", {
    "www-authenticate": 'Bearer realm="gaugeline"',
  });
