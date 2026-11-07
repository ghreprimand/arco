"""Public-plan server acceptance in a temporary home with fixture providers."""
import importlib.util
import subprocess
from pathlib import Path

spec = importlib.util.spec_from_file_location('public_plan_harness', Path(__file__).with_name('connections-browser.py'))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)

class Server(h.IsolatedServer):
    def extra_env(self):
        return {'ARCO_WS_AUTH': 'off', 'ARCO_TEST': '1'}

server = Server('http://127.0.0.1:' + str(h.host_isolation.closed_port()))
try:
    env = {**server.env, 'ARCO_SMOKE_WS_URL': 'ws://127.0.0.1:' + str(server.port) + '/ws', 'ARCO_SMOKE_PROJECT': str(server.projects / 'app'), 'ARCO_SMOKE_ROOT': str(server.projects)}
    result = subprocess.run(['node', '--conditions', 'development', '--import', 'tsx', 'scripts/smoke/public-plan-server.ts'], cwd=h.REPO, env=env, capture_output=True, text=True, timeout=90)
    print(result.stdout[-12000:], flush=True)
    if result.returncode:
        print(result.stderr[-8000:], flush=True)
    assert result.returncode == 0, 'public-plan server acceptance failed'
finally:
    server.close()
