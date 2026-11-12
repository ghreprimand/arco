// Arco-owned model-invoked guidance. Keep testing scope separate from the
// third-party tdd skill's method for writing an individual test.
export const PROPORTIONATE_TESTING_SKILL = {
  slug: 'proportionate-testing',
  name: 'proportionate-testing',
  description: 'Use before writing, adding, running, reviewing or deleting tests, test suites, gates or CI checks, and when a check or release run feels slow.',
  operatorOnly: false,
  body: `# Proportionate testing

Set how much to test with this skill. Use tdd only for how to write one test.
Follow the operator's instructions whenever they ask for more or less testing.

Make each test earn its place. Ask whether removing it would let a real fault a user would notice go undetected. If not, do not write it. Delete an existing test that earns no place, subject to the operator's approval requirements.

Write one test per real fault at the lowest level that catches it. Test pure logic with a unit test. Test a request or store with an integration test. Use a real screen only for a user journey that needs one.

Keep one end-to-end or browser test per journey, covering the happy path. Do not multiply it across layouts, themes, sizes, providers or inputs. If a fault depends on one layout, test that layout alone.

Do not test the framework, configuration values, fixture shapes or the test harness. Do not replace internals to recreate a past incident.

Fix or delete a flaky test. Do not retry it to get a pass.

Budget about ten minutes for the whole check and about five for the browser part. Say when either budget is exceeded. Cut before adding more.

Ask the operator before making a one-off incident into a permanent test, gate or rule. Ask before adding a suite, gate, test tool or CI check.

Before a failing test holds work up, state what a user would lose if the fault were real. Fix wrong results, lost data or broken functionality first. Note cosmetic or momentary faults and carry on.

When reviewing tests, list what to delete or move to a lower level and estimate the time saved.
`,
};
