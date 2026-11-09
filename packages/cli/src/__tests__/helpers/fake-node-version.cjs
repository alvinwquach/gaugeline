// Loaded with node --require (through NODE_OPTIONS) into the built CLI, for tests only. Makes
// process.versions.node report GAUGELINE_TEST_NODE_VERSION, so the "needs Node 22 or newer" guard
// can be tried on any Node without installing an old one.
const fake = process.env.GAUGELINE_TEST_NODE_VERSION;
if (fake) Object.defineProperty(process.versions, "node", { value: fake });
