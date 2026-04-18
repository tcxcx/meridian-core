"""Supervisor for a local 3-node AXL mesh.

Spawns three `axl/node` processes with matched `tcp_port` (gvisor protocol port —
all peers must agree), differentiated `api_port` and bootstrap `Listen`/`Peers`.

Layout:
    node-a (hub)   listen tls://127.0.0.1:7100, api 9002
    node-b (spoke) peer  tls://127.0.0.1:7100, api 9012
    node-c (spoke) peer  tls://127.0.0.1:7100, api 9022
    All:           tcp_port 7200

Hardcoded for the hackathon — Phase 5 may templatise.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("meridian.swarm.nodes")

# Repo-relative paths
SERVICES_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = SERVICES_DIR.parent.parent          # ../../  (montevideo/)
DEFAULT_AXL_BIN = REPO_ROOT / "external" / "axl" / "node"
RUNTIME_DIR = SERVICES_DIR / "swarm_runner" / ".runtime"


@dataclass
class NodeSpec:
    name: str            # "a" | "b" | "c"
    api_port: int
    listen_port: int     # TLS bootstrap port; 0 = no listener (spoke)
    tcp_port: int = 7200
    peers: list[str] = None

    def config(self, key_path: Path) -> dict:
        cfg = {
            "PrivateKeyPath": str(key_path),
            "Peers": self.peers or [],
            "Listen": [f"tls://127.0.0.1:{self.listen_port}"] if self.listen_port else [],
            "api_port": self.api_port,
            "tcp_port": self.tcp_port,
        }
        return cfg


THREE_NODE_LAYOUT: list[NodeSpec] = [
    NodeSpec("a", api_port=9002, listen_port=7100, peers=[]),
    NodeSpec("b", api_port=9012, listen_port=0,    peers=["tls://127.0.0.1:7100"]),
    NodeSpec("c", api_port=9022, listen_port=0,    peers=["tls://127.0.0.1:7100"]),
]


def _which_openssl() -> str:
    # macOS ships LibreSSL which doesn't support `genpkey -algorithm ed25519`.
    # Prefer Homebrew's openssl if present.
    for p in ("/opt/homebrew/opt/openssl/bin/openssl", "/usr/local/opt/openssl/bin/openssl"):
        if Path(p).exists():
            return p
    found = shutil.which("openssl")
    if not found:
        raise RuntimeError("openssl not found")
    return found


def _ensure_key(path: Path) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [_which_openssl(), "genpkey", "-algorithm", "ed25519", "-out", str(path)],
        check=True, capture_output=True,
    )


def _wait_for_api(api_port: int, timeout: float = 8.0) -> bool:
    import urllib.request
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{api_port}/topology", timeout=1) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.2)
    return False


@dataclass
class RunningNode:
    spec: NodeSpec
    pid: int
    public_key: str
    api_url: str


class NodeMesh:
    """Owns 3 AXL processes for the duration of one swarm run."""

    def __init__(self, axl_bin: Path = DEFAULT_AXL_BIN, runtime_dir: Path = RUNTIME_DIR,
                 layout: list[NodeSpec] = None):
        self.axl_bin = axl_bin
        self.runtime_dir = runtime_dir
        self.layout = layout or THREE_NODE_LAYOUT
        self.procs: list[subprocess.Popen] = []
        self.running: list[RunningNode] = []

    def start(self) -> list[RunningNode]:
        if not self.axl_bin.exists():
            raise RuntimeError(
                f"AXL binary not found at {self.axl_bin}. "
                "Build it: cd external/axl && make build"
            )
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        for spec in self.layout:
            wd = self.runtime_dir / spec.name
            wd.mkdir(parents=True, exist_ok=True)
            key = wd / "private.pem"
            _ensure_key(key)
            cfg_path = wd / "node.json"
            cfg_path.write_text(json.dumps(spec.config(key), indent=2))
            log_path = wd / "node.log"
            log.info("starting node-%s api=:%d listen=:%d peers=%s",
                     spec.name, spec.api_port, spec.listen_port, spec.peers)
            proc = subprocess.Popen(
                [str(self.axl_bin), "-config", str(cfg_path)],
                cwd=str(wd),
                stdout=open(log_path, "w"),
                stderr=subprocess.STDOUT,
            )
            self.procs.append(proc)
            # Hub (node a) needs a head start so spokes have something to dial.
            time.sleep(1.5 if spec.name == "a" else 0.5)

        # Wait for every API to come up
        for spec in self.layout:
            if not _wait_for_api(spec.api_port):
                self.stop()
                raise RuntimeError(f"node-{spec.name} api :{spec.api_port} never came up")

        # Capture public keys via /topology
        import urllib.request
        for spec in self.layout:
            with urllib.request.urlopen(f"http://127.0.0.1:{spec.api_port}/topology", timeout=2) as r:
                t = json.loads(r.read())
            self.running.append(RunningNode(
                spec=spec,
                pid=self.procs[len(self.running)].pid,
                public_key=t["our_public_key"],
                api_url=f"http://127.0.0.1:{spec.api_port}",
            ))
        # Give Yggdrasil's spanning tree a moment to converge.
        # Empirically 1.5s leaves spokes seeing only the hub; 3s reliably gets full view.
        time.sleep(3.0)
        log.info("mesh up: %s", [(n.spec.name, n.public_key[:12]) for n in self.running])
        return self.running

    def stop(self) -> None:
        for p in self.procs:
            try:
                p.send_signal(signal.SIGTERM)
            except Exception:
                pass
        for p in self.procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
        self.procs.clear()
        self.running.clear()


def main() -> int:
    """CLI: start the mesh, wait for ctrl-c, then stop. Useful for manual smoke tests."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    mesh = NodeMesh()
    nodes = mesh.start()
    print("\nMesh up. Public keys:")
    for n in nodes:
        print(f"  node-{n.spec.name}  api={n.api_url}  key={n.public_key}")
    print("\nCtrl-C to shut down.")
    try:
        signal.pause()
    except (KeyboardInterrupt, AttributeError):
        pass
    finally:
        mesh.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
