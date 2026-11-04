"""Run cluster WS/REST configuration acceptance against a temporary isolated server."""
import importlib.util
import subprocess
from pathlib import Path
spec = importlib.util.spec_from_file_location('coordination_server_harness', Path(__file__).with_name('connections-browser.py'))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
class Server(h.IsolatedServer):
    def extra_env(self): return {'ARCO_WS_AUTH':'off', 'ARCO_TEST':'1', 'ARCO_TEST_NO_AUTO_TURN_DISPATCH':'1', 'ARCO_CLUSTER_AUTO_TURN_COOLDOWN_MS':'200', 'ARCO_CLUSTER_AUTO_TURN_RATE_CAP_PER_MINUTE':'3', 'ARCO_CLUSTER_AUTO_TURN_MAX_CHAIN_DEPTH':'2'}
server = Server('http://127.0.0.1:' + str(h.host_isolation.closed_port()))
try:
    env = {**server.env, 'ARCO_SMOKE_WS_URL':'ws://127.0.0.1:' + str(server.port) + '/ws'}
    for script in ['cluster-efficiency.ts', 'cluster-progress.ts', 'cluster-snapshot.ts', 'phase-5b.ts']:
        result = subprocess.run(['node','--conditions','development','--import','tsx','scripts/smoke/'+script], cwd=h.REPO, env=env, capture_output=True, text=True, timeout=90)
        print(result.stdout[-18000:], flush=True)
        if result.returncode: print(result.stderr[-8000:], flush=True)
        assert result.returncode == 0, script+' isolated acceptance failed'

finally:
    server.close()
