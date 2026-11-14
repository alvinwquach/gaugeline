import { configure } from "@testing-library/dom";

// waitFor and findBy give up after one second by default. On a loaded CI runner, with the whole suite
// running in parallel, a render and its fetches can take longer than that without anything being wrong.
// The longer limit only matters when a test is about to fail: a passing test never waits for it.
configure({ asyncUtilTimeout: 5000 });
