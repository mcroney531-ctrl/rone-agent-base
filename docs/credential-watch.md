# Credential Watch V1A

A deadline tracker for credentials. It tracks dates, sends warnings, and follows up until you resolve the item. It is **not** a health monitor: nothing here checks that a key works. The full spec is in the Agent Hub project, `credential-watch/v1a-spec.md` (rev 3).

## What it is

- **Inventory.** Tracked credentials are `ops.connections` rows with `kind` set (`sql/016_credentials.sql`).
  - Manual rows are added through the app or `POST /credentials`.
  - The Google connection appears read-only.
  - Each row stores where the secret lives, by name. It never stores the value: the schema and the API both refuse key-shaped text in every free-text field.
- **Dates say what they are:**
  - `expires`: the credential's own expiry.
  - `provider_target`: a provider's announced deprecation date, which may move.
  - `review_by`: a date you chose.

  A passed date of any kind never changes `status`.
- **Known consumers and checks.** `ops.credential_consumers` records each consumer as confirmed or candidate, with evidence. `ops.credential_checks` records what was checked, the result, and when. "Known impact" is derived from these and always qualified. Nothing claims the list is complete.
- **Warnings.** There is one Needs You item per credential, `credential_expiry`.
  - It appears 14 days before the date, re-raises at 7 days, and again when the date passes.
  - Each escalation pushes once.
  - "Got it" hides the item until the next stage.
  - Once the date has passed, the item can only be resolved by:
    - **Renewed**: a new date, or "Doesn't expire".
    - **Not needed / retired**: soft removal.
  - The 30-day stage shows only on the Credentials card.

## Guarantees

- **Nonblocking by construction.** No code here writes `status` or touches `ops.agent_connections`, so `loadAgent` and `agent_health` cannot be affected. The test asserts both.
- **No model, workflow or probe.** Both workers in the test run with `ANTHROPIC_API_KEY` empty.
- **Once per escalation.** `alert_stage` / `alert_stage_since` are written only by the date-edit path (`setDate` in `src/credentials.ts`), in the same transaction as the date change. Crossings caused by time passing are derived in the view (`ops.credential_since`). Time only raises the computed stage, so computed ≥ stored always holds. As a result:
  - An edit that stays in the same stage, or lowers it, carries the old `since`: no push, and an ack keeps holding.
  - An edit that escalates sets `since = now()`: one push.
  - A crossing caused by time dates the warning from the threshold: one push.
  - Stages crossed while nothing could notify (the worker down, quiet hours) collapse into one push for the current stage.
  - Re-entering a stage after you push the date back counts as a new escalation and warns once.

## Accepted limitations

- **At-least-once delivery** (existing platform behaviour). A crash between "push service accepted" and "marked sent" re-sends once after the 2-minute claim lease.
- **The bounded race on stale work.** The notifier re-reads the open items on every tick and only claims deliveries for items that are still open, so a delivery waiting to retry is never sent after its credential is retired or re-dated out of the window (tested). A delivery already *claimed* in the current tick can still be sent if the credential changes during that tick's send, a window of milliseconds up to the 10-second push timeout. The push only deep-links into the app, which re-fetches live state and shows "no longer needs you". Message text is built at send time from the live item and never names the credential.
- **A de-escalation while a push is pending.** If the date is pushed from the 7-day stage back into the 14-day stage while a 7-day delivery is still pending (quiet hours, or a retry), that delivery may still be sent. The item is still open, and the text ("A tracked credential date is coming up") is still true.
- **Manual rows are "not verified".** V1A tracks dates you enter. Checking whether a credential actually works is V1B.

## Not in V1A

Active probing, rotation, a dependency graph, or any new workflow. The rotation invariant is recorded for later: no destructive credential change without reviewed dependency coverage and an explicit account of everything else that loses access.
