# northwind

An invented chain of walk-in clinics, "Northwind Clinics", for the N02 schema rules checks: five
pages and a schema guide (`gaugeline.schema.json`, also used by the CLI test as its working directory).

- `/about` redefines the Organization (with a name and phone) instead of referencing `/#organization`.
- `/blog/flu-season` has a breadcrumb that starts with "Start", not "Home".
- `/blog/new-clinic` matches `/blog/*` but has no BreadcrumbList.

Every @id the pages reference is defined on the homepage, and every page uses the same Organization
and WebSite ids, so schema-id-drift and schema-dangling-ref find nothing.
