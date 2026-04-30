# MIROSHARK · 3-minute demo script

Total: **3:00**. Three acts mirror the dashboard's three-act journey
(INTEL → DELIBERATION → EXECUTION). Per-sponsor callouts are inline so each
prize sees its surface land.

Capture setup:

- Browser: Chrome 1440×1100, no devtools, operator terminal at `http://127.0.0.1:3000/`.
- Voice: dry, builder-tone. Read at ~155 wpm.
- Screen recorder: Quicktime or OBS 60fps. Cursor visible.
- Audio: lavalier or AirPods, no music bed (legibility > polish).
- Pre-recording checklist:
  - `services/` Flask processes up: signal-gateway :5002, execution-router :5004
  - cogito Bun :5003 up (CO`GITO ON` pill green)
  - bridge dry-run wired (`BRIDGE LIVE` pill blue)
  - Demo position seeded:
    `cd services && uv run python -m execution_router.scripts.seed_demo_position`
  - Restart router after seeding so cache hydrates
  - Open `docs/arch.svg` in a second tab (B-roll for sponsor callouts)

---

## ACT 1 · INTEL · `0:00 → 0:50`

**Visual:** operator terminal at `:3000/`. Page loads cold, sidebar JOURNEY shows
INTEL highlighted. Cursor hovers the **`SCAN MARKETS`** button.

**Voice (0:00 → 0:08):**
> MiroShark is a confidential autonomous prediction-market hedge fund.
> The terminal is the operator surface. Three acts: intel, deliberation, execution.

**Action (0:08):** Click `SCAN MARKETS`. Twelve Polymarket rows stream into
the market board, each tagged with a depth tier pill (`DEEP` / `MID` /
`THIN`).

**Voice (0:08 → 0:25):**
> Act one is intel. The signal gateway pulls live Polymarket questions,
> ranks them by orderbook depth, and surfaces the ones worth thinking about.
> Twelve markets, scored, sorted, deep-tier first.

**Action (0:25):** Hover the top row, click it. The market header populates
in DELIBERATION (act 2): question, slug, outcomes (YES / NO), and a
**`RUN SWARM`** button.

**Voice (0:25 → 0:50):**
> Picking a market routes us to act two. The market context, the outcomes,
> and the swarm trigger. We haven't asked the model anything yet, the
> verdict ribbon is empty.

---

## ACT 2 · DELIBERATION · `0:50 → 1:50`

**Visual:** sidebar journey indicator slides to DELIBERATE. ACT 2 head
shows the picked market. Verdict ribbon: `– no signal yet –`.

**Action (0:50):** Click `RUN SWARM`. Status flips to `EVALUATING`. SSE
events stream into the run log: per-agent calls, then per-node consensus,
then the final attested verdict block lands.

**Voice (0:50 → 1:20):**
> Act two runs the swarm. Three Gensyn AXL nodes, five agents each.
> They post their forecasts, the runner aggregates by node, and the
> deliberation produces an edge in basis points and a confidence score.

**B-roll (1:00 → 1:20):** cut to `arch.svg`, highlight the SWARM RUNNER →
COGITO SIDECAR → 0G GALILEO row.

**Voice continues:**
> The cogito sidecar wraps the TypeScript-only SDKs. 0G Storage anchors
> the run inputs. 0G Compute is the inference path when we route through
> DeAIOS. The whole run gets sealed into a TeeML attestation envelope.

**Action (1:20):** Back to dashboard. Verdict ribbon now shows
`outcome: YES · edge: +6.4 pp · conf: 0.71` and an `ATTESTED` pill linked
to the 0G storage root hash.

**Voice (1:20 → 1:50):**
> The verdict is attested. Edge of 6.4 percentage points, confidence
> 0.71. That clears our 3 pp + 0.55 thresholds, so the orchestrator
> hands it to act three.

---

## ACT 3 · EXECUTION · `1:50 → 2:50`

**Visual:** click `OPEN POSITION FROM VERDICT` (or the `JUMP TO EXECUTION ↓`
hero button). Page scrolls to ACT 3. Sidebar journey indicator slides to
EXECUTE. Card animates in.

**Voice (1:50 → 2:10):**
> Act three is settlement. We derive a fresh burner EOA per position from
> a treasury-held seed. The hook funds the burner with encrypted fhUSDC
> on Arbitrum Sepolia, that's the Fhenix CoFHE leg.

**Action (2:00):** Cursor traces left column row by row: burner address,
fund_burner tx, bridge → amoy, clob order, gateway deposit, bridge → arb,
resolve, settle.

**Voice (2:10 → 2:35):**
> Circle Gateway carries the USDC from Arbitrum Sepolia to Polygon Amoy
> with a sub-500-millisecond Forwarder mint. The burner submits the
> Polymarket order. On resolve we run the path in reverse: deposit on
> Polygon, bridge back to Arbitrum, mark resolved on the hook, settle.
> KeeperHub wraps the on-chain calls so the treasury key never has to
> hot-sign.

**B-roll (2:20 → 2:35):** cut to `arch.svg`, highlight the central CIRCLE
GATEWAY box and the EXECUTION ROUTER → settlement / trading split.

**Action (2:35):** Cursor moves to the right column, the
**PROOF-OF-EXECUTION TIMELINE**. Eleven events, monospace, ascending
timestamps from `open.received` to `settled.ok`.

**Voice (2:35 → 2:50):**
> The append-only audit log is the proof. Every state-changing op,
> every external system effect, redacted at the boundary, queryable per
> position. This is the receipt the operator hands to compliance.

---

## CLOSE · `2:50 → 3:00`

**Visual:** wide shot of the dashboard, footer SPONSOR strip readable
(MIROSHARK · 0G · GENSYN · FHENIX · UNISWAP · CIRCLE · KEEPERHUB).

**Voice (2:50 → 3:00):**
> Confidential autonomous prediction-market hedge fund. Built on 0G,
> Gensyn, Fhenix, Uniswap v4, Circle Gateway, KeeperHub. Three acts,
> one terminal, zero hot keys. That's MiroShark.

---

## Sponsor callouts (inline, do not skip)

| Sponsor | Where in script | What gets shown |
|---|---|---|
| **0G** | 1:00, 1:20 | cogito sidecar; storage root hash on attested verdict |
| **Gensyn AXL** | 0:50, 1:00 | 3-node mesh, 5 agents/node, run log |
| **Fhenix CoFHE** | 1:50 | encrypted fhUSDC fund_burner on Arb Sepolia |
| **Uniswap v4** | (B-roll arch.svg) | PrivateSettlementHook + HybridFHERC20 box |
| **Circle Gateway** | 2:00, 2:20, 2:35 | central gateway box; bridge → amoy + bridge → arb rows |
| **KeeperHub** | 2:10 | KeeperHub pill on EXECUTION ROUTER box |

## Cuts to keep tight

- Skip the SIGNAL INSTRUMENTS sidebar (E-01 / C-02 / T-03 / S-00). Mention
  only if there's slack at the end.
- Don't open the burner private key panel.
- Don't show the audit DB query directly. The right-column timeline is
  enough.
