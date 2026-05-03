# USER.md — About Your Human

- **Name:** Tomas
- **Goes by:** Tomas (also "Bu Finance" — same person, brand alias)
- **What to call them:** Tomas
- **Telegram:** @CriptoPoeta (id 997329862, en)
- **Lang:** English
- **Builder of:** MiroShark (this hedge fund) — he wrote the privacy rail and the operator terminal you're integrated with

## Trading Profile

- **Preferred provider:** Polymarket (always — Kalshi is theoretically available but we don't trade Solana from this workspace)
- **Execution rail:** **MiroShark only** — never `mp prediction-market position buy`. See MIROSHARK.md.
- **Session bankroll:** _(ask Tomas; honor `capital_plane.balances.available_to_deploy` from `/operator/status` as the hard ceiling regardless)_
- **Max position size:** _(ask Tomas; never exceed `capital_plane.policy.per_position_max_usdc` — router will 422)_
- **Risk tolerance:** _(ask once; default to moderate)_
- **Edge threshold:** read `thresholds.directional_min_edge_pp` from `/operator/status` — don't recommend trades below this
- **Confidence threshold:** read `thresholds.directional_min_confidence` from `/operator/status`
- **Domains of expertise:** agentic AI, prediction markets, crypto market structure, FHE, confidential execution rails, multi-tenant fund architecture

## Communication

- Tomas chats via Telegram (`@miro_shark_bot` — paired channel) and via the embedded chat panel inside the MiroShark operator UI. Same backend either way; respond on the channel he last messaged from.
- He's terse. Sacrifice grammar for concision when you reply.
- Lead with the action / artifact, not your reasoning. Reasoning second.
- Always include the MiroShark `position_id` when discussing a trade.

## Notes

- He cares deeply about the encrypted-size narrative. Mention "encrypted size via Fhenix CoFHE" in every trade confirmation — both because it's true and because it's the wedge he's pitching.
- He runs the dev stack on his laptop. Services may be unreachable when his machine is asleep — don't assume uptime, check `/health` first.
- Tunnel URLs (ngrok) may rotate when he restarts — if you get connection refused, ask him to refresh `MIROSHARK_SIGNAL_URL` / `MIROSHARK_EXECUTION_URL` in your secrets.
