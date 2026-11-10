import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

import host_isolation

with patch.object(host_isolation, 'enter_isolated_network'):
    spec = importlib.util.spec_from_file_location('connections_browser', Path(__file__).with_name('connections-browser.py'))
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)


class StartupCleanupTest(unittest.TestCase):
    def test_spawn_failure_removes_fixture(self):
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent) / 'fixture'
            root.mkdir()
            with patch.object(fixture.tempfile, 'mkdtemp', return_value=str(root)), \
                 patch.object(fixture.host_isolation, 'harden', return_value={}), \
                 patch.object(fixture.subprocess, 'Popen', side_effect=OSError('spawn failed')):
                with self.assertRaisesRegex(OSError, 'spawn failed'):
                    fixture.IsolatedServer('http://127.0.0.1:1')
            self.assertFalse(root.exists())

    def test_early_exit_removes_fixture_and_reaps_process(self):
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent) / 'fixture'
            root.mkdir()
            proc = MagicMock()
            proc.poll.return_value = 1
            with patch.object(fixture.tempfile, 'mkdtemp', return_value=str(root)), \
                 patch.object(fixture.host_isolation, 'harden', return_value={}), \
                 patch.object(fixture.subprocess, 'Popen', return_value=proc):
                with self.assertRaisesRegex(RuntimeError, 'server exited'):
                    fixture.IsolatedServer('http://127.0.0.1:1')
            self.assertFalse(root.exists())
            proc.wait.assert_called_once()


if __name__ == '__main__':
    unittest.main()
