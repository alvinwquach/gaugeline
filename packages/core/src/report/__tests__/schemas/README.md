# Schemas the format tests validate against

- `junit-10.xsd` is the JUnit XML schema from the Jenkins xunit plugin
  (https://github.com/jenkinsci/xunit-plugin, `junit-10.xsd`), copied unchanged. It carries its own
  MIT licence header (Copyright (c) 2014, Gregory Boissinot). The test runs `xmllint --schema` on
  it when `xmllint` is installed, and always checks the same rules by hand.
- `sarif-2.1.0-subset.schema.json` is written for these tests from the SARIF 2.1.0 specification
  (https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html, section 3). It is NOT the OASIS
  schema file. Checked on 12 Nov 2026: the sarif-spec repository's LICENSE.md only points to the
  OASIS IPR policy ("RF on RAND Terms Mode", which is about patents) and its README and CONTRIBUTING
  say the content is "freely available" and "may be re-used freely ... subject to applicable
  licensing rules", but no file grants a copyright licence to redistribute, and the schema file has
  no header. That is not clear enough to copy it here, so it is not copied.
  It covers every property Gaugeline writes and closes each object, so an invented or misspelt
  property fails. If the owner confirms the OASIS file may be vendored, add it beside this one and
  point `formats.test.ts` at it.
