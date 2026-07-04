// Test entrypoint — importing a test module registers its node:test cases, which
// the runtime executes on exit (exit code reflects failures). Run: npm test.
import './assay/scorer.test';
import './matchers/matcher.test';
import './readers/registryLoader.test';
