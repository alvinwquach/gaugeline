# preview-vercel

The `plan-built` pages behind an invented stand-in for Vercel deployment protection (G17a). Every
path answers 401 with a login page linking to Vercel's SSO unless the request carries
`x-vercel-protection-bypass: gaugeline-fixture-bypass-0001`. The value is invented and opens nothing.
