"""DNS fallback for hosts that the user's local resolver returns NXDOMAIN for.

Some local routers / ISP resolvers fail to resolve Polymarket's API hosts (Cloudflare-fronted)
even though 1.1.1.1 / 8.8.8.8 resolve them fine. We monkey-patch socket.getaddrinfo so
httpx + the OpenAI SDK can fall back to a hardcoded IP. Long-term fix: change system DNS to
1.1.1.1 / 8.8.8.8 (or run inside docker which uses Docker's resolver).
"""
from __future__ import annotations

import logging
import socket

log = logging.getLogger("meridian.dns")

# Cloudflare IPs Polymarket fronts behind. These rotate but resolve very stably.
_FALLBACK_IPS: dict[str, str] = {
    "gamma-api.polymarket.com": "104.18.34.205",
    "clob.polymarket.com": "172.64.153.51",
    "data-api.polymarket.com": "172.64.153.51",
}

_real_getaddrinfo = socket.getaddrinfo
_patched = False


def install() -> None:
    global _patched
    if _patched:
        return

    def _wrapped(host, *args, **kwargs):
        try:
            return _real_getaddrinfo(host, *args, **kwargs)
        except socket.gaierror:
            ip = _FALLBACK_IPS.get(host)
            if ip:
                log.warning("DNS fallback: %s -> %s", host, ip)
                return _real_getaddrinfo(ip, *args, **kwargs)
            raise

    socket.getaddrinfo = _wrapped  # type: ignore[assignment]
    _patched = True
