"""Vite /@fs/ URL helpers shared by the browser smokes.

Vite serves absolute files as /@fs/<posix path> on Linux and macOS and as
/@fs/<drive>:/<path> on Windows; concatenating '/@fs' with a native path or
slicing the prefix by hand breaks on drive letters and backslashes."""
import re
from pathlib import Path
from urllib.parse import unquote


def fs_url(path):
    """Return the /@fs/ URL path for a local file or directory."""
    return '/@fs/' + Path(path).resolve().as_posix().lstrip('/')


def fs_path(url_path):
    """Return the local path named by a /@fs/ URL path."""
    rest = unquote(url_path[len('/@fs/'):]).lstrip('/')
    return Path(rest) if re.match(r'^[A-Za-z]:', rest) else Path('/' + rest)
