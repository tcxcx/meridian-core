from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import quote
from xml.etree import ElementTree as ET

import httpx

from .audit import AuditLog
from .store import PositionRecord, PositionStore

GOOGLE_NEWS_FEEDS = (
    "Reuters markets when:1d",
    "Reuters crypto when:1d",
    "Bloomberg markets when:1d",
    "Bloomberg crypto when:1d",
)

STOOQ_QUOTES = (
    ("gold", "GOLD", "gc.f"),
    ("oil", "WTI", "cl.f"),
    ("nasdaq", "NASDAQ", "^ndq"),
)


@dataclass
class TickerSnapshot:
    headlines: list[dict[str, Any]]
    prices: list[dict[str, Any]]
    events: list[dict[str, Any]]
    tape: list[dict[str, Any]]
    updated_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "headlines": self.headlines,
            "prices": self.prices,
            "events": self.events,
            "tape": self.tape,
            "updated_at": self.updated_at,
        }


class TerminalTicker:
    def __init__(self, *, store: PositionStore, audit: AuditLog, ttl_s: int = 90) -> None:
        self._store = store
        self._audit = audit
        self._ttl_s = ttl_s
        self._lock = threading.Lock()
        self._cache: TickerSnapshot | None = None
        self._cache_ts = 0.0
        self._client = httpx.Client(
            timeout=15.0,
            follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 MERIDIAN TerminalTicker"},
        )

    def snapshot(self, *, force: bool = False) -> dict[str, Any]:
        now = time.time()
        with self._lock:
            if not force and self._cache and (now - self._cache_ts) < self._ttl_s:
                return self._cache.to_dict()

            headlines = self._fetch_headlines()
            prices = self._fetch_prices()
            events = self._build_events()
            tape = self._interleave(prices, events)
            snap = TickerSnapshot(
                headlines=headlines,
                prices=prices,
                events=events,
                tape=tape,
                updated_at=datetime.now(timezone.utc).isoformat(),
            )
            self._cache = snap
            self._cache_ts = now
            return snap.to_dict()

    def _fetch_headlines(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        seen: set[str] = set()
        for query in GOOGLE_NEWS_FEEDS:
            url = (
                "https://news.google.com/rss/search?q="
                f"{quote(query)}&hl=en-US&gl=US&ceid=US:en"
            )
            try:
                resp = self._client.get(url)
                resp.raise_for_status()
                root = ET.fromstring(resp.text)
            except Exception:
                continue

            channel = root.find("channel")
            if channel is None:
                continue

            for item in channel.findall("item"):
                raw_title = (item.findtext("title") or "").strip()
                source = (item.findtext("source") or "").strip() or self._guess_source(raw_title)
                if source not in {"Reuters", "Bloomberg"}:
                    continue

                title = self._clean_title(raw_title, source)
                if not title or title in seen:
                    continue
                seen.add(title)

                published = self._parse_pubdate(item.findtext("pubDate"))
                items.append({
                    "kind": "headline",
                    "source": source,
                    "anchor": f"{source} Desk: {title}",
                    "title": title,
                    "url": (item.findtext("link") or "").strip(),
                    "published_at": published.isoformat() if published else None,
                    "published_label": self._relative_time_label(published),
                })

        items.sort(key=lambda item: item.get("published_at") or "", reverse=True)
        return items[:10]

    def _fetch_prices(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []

        try:
            resp = self._client.get(
                "https://api.coingecko.com/api/v3/simple/price",
                params={
                    "ids": "bitcoin,ethereum,solana",
                    "vs_currencies": "usd",
                    "include_24hr_change": "true",
                },
            )
            resp.raise_for_status()
            data = resp.json()
            rows.extend([
                {
                    "kind": "price",
                    "symbol": "BTC",
                    "label": "Bitcoin",
                    "price": float(data["bitcoin"]["usd"]),
                    "change_pct": float(data["bitcoin"].get("usd_24h_change") or 0.0),
                },
                {
                    "kind": "price",
                    "symbol": "ETH",
                    "label": "Ethereum",
                    "price": float(data["ethereum"]["usd"]),
                    "change_pct": float(data["ethereum"].get("usd_24h_change") or 0.0),
                },
                {
                    "kind": "price",
                    "symbol": "SOL",
                    "label": "Solana",
                    "price": float(data["solana"]["usd"]),
                    "change_pct": float(data["solana"].get("usd_24h_change") or 0.0),
                },
            ])
        except Exception:
            pass

        for key, symbol, stooq_symbol in STOOQ_QUOTES:
            try:
                resp = self._client.get(f"https://stooq.com/q/l/?s={quote(stooq_symbol)}&i=d")
                resp.raise_for_status()
                parts = [part.strip() for part in resp.text.strip().split(",")]
                if len(parts) < 7 or parts[6] in {"N/D", ""}:
                    continue
                rows.append({
                    "kind": "price",
                    "symbol": symbol,
                    "label": key,
                    "price": float(parts[6]),
                    "change_pct": None,
                })
            except Exception:
                continue

        return rows

    def _build_events(self) -> list[dict[str, Any]]:
        positions = sorted(self._store.list(), key=lambda row: row.updated_at, reverse=True)
        active = [row for row in positions if row.status not in {"settled", "failed"}]
        settled = [row for row in positions if row.status == "settled"]
        risk = sum(float(row.usdc_amount or 0.0) for row in active)

        events: list[dict[str, Any]] = [{
            "kind": "event",
            "label": f"Operator: {len(active)} active · {len(settled)} settled · {self._fmt_usd(risk)} at risk",
        }]

        if positions:
            latest = positions[0]
            events.append({
                "kind": "event",
                "label": (
                    f"Latest position: {self._shorten(latest.position_id, 8)} "
                    f"{latest.status} · {latest.strategy} · {self._fmt_usd(latest.usdc_amount)}"
                ),
            })

        for record in positions[:3]:
            if record.error:
                events.append({
                    "kind": "event",
                    "label": f"Risk flag: {self._shorten(record.position_id, 8)} failed · {record.error}",
                })
            elif record.payout_usdc is not None and record.status == "settled":
                events.append({
                    "kind": "event",
                    "label": (
                        f"Settlement: {self._shorten(record.position_id, 8)} "
                        f"paid {self._fmt_usd(record.payout_usdc)}"
                    ),
                })

        for audit_event in self._audit.recent(limit=6):
            detail = self._summarize_audit(audit_event)
            if detail:
                events.append({"kind": "event", "label": detail})

        deduped: list[dict[str, Any]] = []
        seen: set[str] = set()
        for event in events:
            label = event["label"]
            if label in seen:
                continue
            seen.add(label)
            deduped.append(event)
        return deduped[:10]

    def _interleave(self, prices: list[dict[str, Any]], events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        max_len = max(len(prices), len(events))
        for index in range(max_len):
            if index < len(prices):
                out.append(prices[index])
            if index < len(events):
                out.append(events[index])
        return out

    @staticmethod
    def _clean_title(title: str, source: str) -> str:
        suffix = f" - {source}"
        if title.endswith(suffix):
            return title[: -len(suffix)].strip()
        return title.strip()

    @staticmethod
    def _guess_source(title: str) -> str:
        if title.endswith(" - Reuters"):
            return "Reuters"
        if title.endswith(" - Bloomberg"):
            return "Bloomberg"
        return ""

    @staticmethod
    def _parse_pubdate(value: str | None) -> datetime | None:
        if not value:
            return None
        try:
            return parsedate_to_datetime(value).astimezone(timezone.utc)
        except Exception:
            return None

    @staticmethod
    def _relative_time_label(ts: datetime | None) -> str:
        if ts is None:
            return "latest"
        delta = datetime.now(timezone.utc) - ts
        seconds = max(int(delta.total_seconds()), 0)
        if seconds < 3600:
            minutes = max(seconds // 60, 1)
            return f"{minutes}m ago"
        hours = seconds // 3600
        if hours < 24:
            return f"{hours}h ago"
        return ts.strftime("%b %d")

    @staticmethod
    def _fmt_usd(value: float | None) -> str:
        return f"${float(value or 0.0):,.2f}"

    @staticmethod
    def _shorten(value: str | None, limit: int = 12) -> str:
        raw = str(value or "—")
        return raw if len(raw) <= limit else f"{raw[:limit]}…"

    def _summarize_audit(self, event: dict[str, Any]) -> str | None:
        name = event.get("event") or ""
        payload = event.get("payload") or {}
        position_id = self._shorten(event.get("position_id"), 8)
        if name.endswith(".err"):
            error = payload.get("error") or name
            return f"Execution alert: {position_id} {name} · {error}"
        if name.endswith(".ok"):
            if payload.get("payout_usdc") is not None:
                return f"Execution: {position_id} {name} · payout {self._fmt_usd(payload['payout_usdc'])}"
            if payload.get("order_id"):
                return f"Execution: {position_id} order live · {self._shorten(payload['order_id'], 12)}"
            return f"Execution: {position_id} {name}"
        return None
