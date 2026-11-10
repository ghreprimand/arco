import { createServer } from 'node:net';

export async function outputsFixtureEnvironment(suiteName, env, excludedPort) {
  if (suiteName !== 'outputs') return { ...env };
  let port;
  for (let attempt = 0; attempt < 10; attempt++) {
    port = await new Promise((resolve, reject) => {
    const server = createServer().once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const selected = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(selected));
    });
    });
    if (port !== excludedPort) break;
  }
  if (port === excludedPort || !port) throw new Error('Could not select a separate outputs fixture port.');
  return { ...env, ARCO_PORT: String(port), ARCO_TEST_FIXTURE_PORT: String(port) };
}
