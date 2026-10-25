"""Host isolation for the browser acceptance harnesses that start a real Arco server.

A temporary HOME alone does NOT isolate a server: at boot it appends /usr/local/bin,
/usr/bin and /usr/sbin to PATH (runtimeEnv.ts), runs `systemctl --user show-environment`,
probes provider CLIs for their versions, and probes the default loopback endpoints of
Ollama, LM Studio, Strata, Antigravity and friends. This module closes that in two layers:

  1. harden(env, root)  - the server's PATH starts with a directory of denying stubs for
     every provider CLI / service tool (they log the attempt to <root>/deny.log and exit
     97, so a real executable can never win the PATH merge, which is first-wins), and
     every endpoint the server reads from the environment points at a closed loopback
     port. No credential, config or service of the host is reachable through them.
  2. enter_isolated_network() - re-executes the whole test under an empty network
     namespace (`unshare -rn`, loopback only), so a default endpoint that the server
     would contact despite the environment can only be reached inside the test itself.
     Hosted runners that forbid unprivileged namespaces fall back to layer 1 and say so;
     set ARCO_TEST_REQUIRE_NETNS=1 to make that fatal.

Proof that both layers hold lives in server/src/http/hostIsolation.test.ts.
"""
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path

ACTIVE = 'ARCO_TEST_NETNS_ACTIVE'

DENIED_COMMANDS = (
    'claude', 'codex', 'gemini', 'cursor-agent', 'agent', 'ollama', 'llama-server', 'llama-cli',
    'lms', 'antigravity', 'xolotl', 'docker', 'podman', 'gh', 'systemctl', 'journalctl',
    'ssh', 'curl', 'wget',
)


def closed_port():
    """A loopback port nothing listens on (bound then released)."""
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def install_stubs(root):
    stubs = Path(root) / 'deny-bin'
    stubs.mkdir(parents=True, exist_ok=True)
    log = Path(root) / 'deny.log'
    for name in DENIED_COMMANDS:
        target = stubs / name
        target.write_text(
            '#!/bin/sh\n'
            f'echo "{name} $*" >> "{log}"\n'
            'echo "Host provider and service commands are disabled in acceptance tests." >&2\n'
            'exit 97\n')
        target.chmod(0o755)
    return stubs, log


def harden(env, root):
    """Return env with denying stubs first on PATH and every host endpoint disabled."""
    stubs, log = install_stubs(root)
    dead = f'http://127.0.0.1:{closed_port()}'
    hardened = dict(env)
    hardened['PATH'] = os.pathsep.join([str(stubs), os.path.dirname(shutil.which('node')), '/usr/bin', '/bin'])
    home = hardened.get('HOME', str(Path(root) / 'home'))
    hardened.update({
        'DEEPSEEK_URL_BASE': dead + '/v1', 'OLLAMA_URL_BASE': dead, 'LMSTUDIO_URL_BASE': dead + '/v1', 'STRATA_URL_BASE': dead + '/v1',
        'ARCHON_LLAMACPP_BIN': str(stubs / 'llama-server'), 'ARCHON_LLAMACPP_HOST': '127.0.0.1',
        'ARCHON_LLAMACPP_PORT': str(closed_port()),
        'ANTIGRAVITY_BINARY': str(stubs / 'antigravity'), 'ANTIGRAVITY_CDP_PORT': str(closed_port()),
        'ARCHON_SEARXNG_URL': dead, 'ARCHON_CHROME_BINARY': str(stubs / 'curl'), 'CHROME_PATH': str(stubs / 'curl'),
        'CODEX_HOME': f'{home}/.codex', 'CLAUDE_CONFIG_DIR': f'{home}/.claude',
        'XDG_CONFIG_HOME': f'{home}/.config', 'XDG_DATA_HOME': f'{home}/.local/share', 'XDG_CACHE_HOME': f'{home}/.cache',
        'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
    })
    for key in ('ARCHON_HUB_URL', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'):
        hardened.pop(key, None)
    hardened['ARCO_TEST_DENY_LOG'] = str(log)
    return hardened


def _wrappers():
    uid, gid = os.getuid(), os.getgid()
    # Inner user namespace maps the invoking uid back (not root); plain -rn is the fallback.
    return [
        ['sh', '-c', f'ip link set lo up && exec unshare -U --map-user={uid} --map-group={gid} "$@"', 'sh'],
        ['sh', '-c', 'ip link set lo up && exec "$@"', 'sh'],
    ]


def _namespace_wrapper():
    for wrapper in _wrappers():
        try:
            if subprocess.run(['unshare', '-rn'] + wrapper + ['true'], capture_output=True, timeout=15).returncode == 0:
                return wrapper
        except Exception:
            continue
    return None


def enter_isolated_network():
    """Re-exec this process inside an empty network namespace (loopback only)."""
    if os.environ.get(ACTIVE) == '1':
        return
    if os.environ.get('ARCO_TEST_NETNS') == '0':
        print('note: network namespace disabled by ARCO_TEST_NETNS=0 (layer 1 only)', file=sys.stderr)
        return
    wrapper = _namespace_wrapper() if shutil.which('unshare') and shutil.which('ip') else None
    if wrapper:
        os.environ[ACTIVE] = '1'
        argv = getattr(sys, 'orig_argv', None) or [sys.executable] + sys.argv
        os.execvp('unshare', ['unshare', '-rn'] + wrapper + argv)
    if os.environ.get('ARCO_TEST_REQUIRE_NETNS') == '1':
        sys.exit('an isolated network namespace is required (ARCO_TEST_REQUIRE_NETNS=1) but unshare -rn is unavailable')
    print('note: no network namespace available; relying on environment hardening only', file=sys.stderr)
