import json
import os
import subprocess
import tempfile
import unittest

import host_isolation


class HostIsolationTest(unittest.TestCase):
    def test_child_environment_drops_inherited_service_configuration(self):
        blocked = ('ARCO_HUB_URL', 'ARCO_NTFY_URL', 'ARCO_LOG_FILE', 'ARCO_SERVE_CLIENT')
        env = dict(os.environ)
        for key in (*blocked, ('ARCH' + 'ON_HUB_URL'), ('ARCH' + 'ON_NTFY_URL'),
                    ('ARCH' + 'ON_LOG_FILE'), ('ARCH' + 'ON_SERVE_CLIENT'), ('ARCH' + 'ON_OTHER')):
            env[key] = 'inherited-value'
        with tempfile.TemporaryDirectory() as root:
            child = host_isolation.harden(env, root)
            output = subprocess.check_output(
                ['node', '-e', 'process.stdout.write(JSON.stringify(process.env))'],
                env=child, text=True,
            )
        actual = json.loads(output)
        self.assertFalse([key for key in actual if key.startswith(('ARCH' + 'ON_')) or key in blocked])
        self.assertEqual(actual['ARCO_UPDATE_CHECK'], '0')


if __name__ == '__main__':
    unittest.main()
