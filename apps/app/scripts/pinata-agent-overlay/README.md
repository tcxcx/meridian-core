# pinata-agent-overlay

The MiroShark integration patch for the upstream Pinata "MoonPay Prediction
Market Trader" template (`tak2z2xg` / slug `moonpay-prediction-trader`).

When you redeploy a fresh agent from that template (because the trial expired,
because you want a clean slate, or because you're re-publishing as a new agent
on Pinata), `apps/app/scripts/redeploy-pinata-agent.sh` clones the new agent
and overlays these files on top.

## Layout
- `manifest.json` — replaces upstream `manifest.json`. Adds 5 secrets
  (`MIROSHARK_*`) and replaces the two upstream tasks with three MiroShark-
  aware ones (`miroshark-book-check`, `miroshark-morning-markets`,
  `miroshark-resolve-sweep`).
- `workspace/MIROSHARK.md` — new file. Operator briefing for the agent.
- `workspace/skills/miroshark.md` — new file. Endpoint cookbook with curl
  examples and JSON shapes.
- `workspace/AGENTS.md` — replaces upstream. Adds MiroShark-mode section,
  layout pointer to MIROSHARK.md.
- `workspace/SOUL.md` — replaces upstream. Marks `mp position buy/sell/redeem`
  as deprecated, replaces with HTTP examples.
- `workspace/TOOLS.md` — replaces upstream. Adds MiroShark HTTP rail section
  at top, marks `mp position` groups deprecated.
- `workspace/USER.md` — replaces upstream. Tomas profile filled in.

## Updating the overlay

When you change the agent's behavior (edit `.context/pinata-agent-<id>/`),
sync the changes back into this overlay so future redeploys carry them:

```bash
cd <miroshark-repo>
SRC=.context/pinata-agent-<your-current-id>
DEST=apps/app/scripts/pinata-agent-overlay
cp $SRC/manifest.json $DEST/
cp $SRC/workspace/MIROSHARK.md $DEST/workspace/
cp $SRC/workspace/skills/miroshark.md $DEST/workspace/skills/
cp $SRC/workspace/AGENTS.md $DEST/workspace/
cp $SRC/workspace/SOUL.md $DEST/workspace/
cp $SRC/workspace/TOOLS.md $DEST/workspace/
cp $SRC/workspace/USER.md $DEST/workspace/
git add $DEST && git commit -m "chore(pinata-overlay): sync from agent <id>"
```
