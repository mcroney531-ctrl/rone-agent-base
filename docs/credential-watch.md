# Credential Watch V1A

A deadline tracker for credentials. It tracks dates, sends warnings, and follows up until you resolve the item. It is **not** a health monitor: nothing here checks that a key works. The full spec is in the Agent Hub project, `credential-watch/v1a-spec.md` (rev 3).

## What it is

- **Inventory.**
  - Tracked credentials are `ops.connections` rows with `kind` set (`sql/016_credentials.sql`).
  - Manual rows are added through the app or `POST /credentials`, and are `managed_by = 'manual'`.
  - The Google connection appears read-only.
  - No field stores a credential's value. See "Secret handling" below for exactly what is enforced where.
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

## Ownership boundary (review finding D1/D2)

`ops.connections` is shared between integrations (Google OAuth, Research Watch feeds) and Credential Watch, so every row says who owns it in `managed_by`.

- **Integration code only touches `managed_by = 'integration'` rows.** That covers:
  - Listing: `listIntegrationConnections`, and the feed source queries.
  - Writes in `src/connections/store.ts`: `markActive`, `markReauthRequired`, `markChecked` and `mergeMetadata` all filter on ownership in their `WHERE`.
  - Every Google lookup through an agent link, including the Gmail ingress path and `ops.mail_push_health`.

  A manually tracked credential whose provider is `google` (a Gemini or Google Cloud key) or `feed` is never claimed by those integrations, before or after a restart. `scripts/test-credentials-regressions.ts` proves it.
- **Credential Watch writes only `managed_by = 'manual'` rows,** with ids prefixed `cred:`. Integration ids are `google:…` and `feed:…`.
- **Manual credentials may use any provider name, including `google`.** Ownership, not the provider name, is the boundary.

## Secret handling (defense in depth, not a guarantee)

| Where | What is enforced | Strength |
|---|---|---|
| Credential values | **No field accepts or stores one.** There is no value field anywhere in the schema or API. | By design |
| `secret_ref` ("where it is stored") | A **database CHECK**, `connections_secret_ref_v1` → `ops.secret_ref_ok_v1`: known key formats, JWTs, private keys, URLs with a password, long mixed-case tokens, and 32+ hex characters. | Enforced on every write, even outside the API. Still a heuristic: it can miss a key with an unknown format. |
| Name, notes, renewal URL, consumer, evidence, check scope and result | An **API check**, `ops.looks_like_secret`: the same patterns without the hex rule, so commit SHAs and page ids are allowed. | Best effort; not enforced in the database. |
| API responses and notifications | Never contain a value, because none is stored. The lock-screen text never contains the credential's name. The push payload's `tag`/`url` carry the credential id (a slug of its name), which the phone doesn't display. | By design |

**Changing the database check.** `ops.secret_ref_ok_v1` is frozen. A CHECK is validated only when it's added, so editing the function would apply new rules to new writes while old rows went unchecked. Re-adding the constraint on every boot (the original V1A did this) can stop every replica from booting. Instead, the constraint is added once and never re-added on boot.

**The swap is atomic and fails closed.** `applySql` sends each migration file as one multi-statement query, which Postgres runs as a single implicit transaction. So if v1 can't be added, the drop of the old constraint rolls back with it: the table keeps the old protection or gets the new one, never neither, and the worker refuses to boot. `scripts/test-credentials-regressions.ts` proves this ("D8 atomic"). The same test fails if the drop is run as a separately committed statement. To change the rules:
1. Create `ops.secret_ref_ok_v2`.
2. In a new migration, add `connections_secret_ref_v2` as `NOT VALID`.
3. Clean up any rows it flags.
4. Run `ALTER TABLE ops.connections VALIDATE CONSTRAINT connections_secret_ref_v2` deliberately.
5. Drop v1.

`ops.looks_like_secret` (the API check) can be widened at any time.

## Accepted limitations

- **At-least-once delivery** (existing platform behaviour). A crash between "push service accepted" and "marked sent" re-sends once after the 2-minute claim lease.
- **The bounded race on stale work.** The notifier re-reads the open items on every tick and only claims deliveries for items that are still open, so a delivery waiting to retry is never sent after its credential is retired or re-dated out of the window (tested). A delivery already *claimed* in the current tick can still be sent if the credential changes during that tick's send, a window of milliseconds up to the 10-second push timeout. The push only deep-links into the app, which re-fetches live state and shows "no longer needs you". Message text is built at send time from the live item and never names the credential.
- **A de-escalation while a push is pending.** If the date is pushed from the 7-day stage back into the 14-day stage while a 7-day delivery is still pending (quiet hours, or a retry), that delivery may still be sent. The item is still open, and the text is still true: the push is built at send time from the live item, and its only wording is "A tracked credential date is coming up" or "…has passed", with no day count (confirmed by the independent review).
- **Secret detection is a heuristic.** See "Secret handling" above: a key in an unknown format can get through.
- **Manual rows are "not verified".** V1A tracks dates you enter. Checking whether a credential actually works is V1B.

## Latent defects (recorded, not fixed)

- **D9: a passed integration-managed date would leave an item with no actions.**
  - **Trigger:** integration code (Google, feeds) starts writing `expires_at` on its own rows.
  - **Effect:** such a row's `credential_expiry` item would reach the passed stage with no Renewed, Got it, or Retire action, so it could not be resolved from Needs You.
  - **Today:** nothing writes `expires_at` on integration rows, so it cannot happen.
  - **Fix when triggered:** give integration rows an integration-specific action, such as Reconnect, or keep them out of the `credential_expiry` branch.
- **The `setDate` row lock is not exercised by a concurrent-edit test.** Removing it is not caught (review mutation M8). The lock is present and needed: two simultaneous edits could otherwise compute their stage from the same old state.

## Not in V1A

Active probing, rotation, a dependency graph, or any new workflow. The rotation invariant is recorded for later: no destructive credential change without reviewed dependency coverage and an explicit account of everything else that loses access.

## Scoped agent identity (`claude-credentials`)

Claude maintains the inventory as its own identity, not as the owner.

- **Token delivery.** `CREDENTIALS_AGENT_TOKEN` is set on the worker. The same value is stored as a *network secret* on the Claude Code cloud environment, scoped to the worker host and the `/credentials` path. The environment's proxy attaches it outside Claude's sandbox, so Claude never holds the value and cannot present any other identity on those routes.
- **Default deny.** `AGENT_ALLOWED` in `src/auth.ts` lists the exact routes the identity may call: whoami, list/read, create, update, read events, add consumer, add check. Every other route returns 403 before any handler runs, including retire, consumer removal, every Needs You action and routes added later.
- **Never forwarded.** The agent token is matched before the Supabase session check, so a live agent token is never sent to Supabase Auth.
- **Fails closed.** A token shorter than 32 characters is ignored, so the identity does not exist.
- **Revocation.** Remove or change the Railway variable. The old token then returns 401 on the next deploy. A revoked token is treated like any unknown bearer token: it is checked against Supabase Auth, which rejects it.
- **Tests.** `scripts/test-agent-identity.ts` covers whoami, near-miss tokens, the 403s with no side effects, the Supabase leak, unset/short/rotated tokens. A mutation that removes the gate is caught.

## Managed writes

Every credential mutation by any caller runs in one transaction. The same transaction writes its `ops.credential_events` row (actor, op, evidence level and note, idempotency key, before/after snapshot). If the audit row fails, the change rolls back.

**Identity and retries**
- **Credentials:** identity is the id, never the name. Two credentials with the same name stay two. The agent creating one at a provider + secret location already tracked gets a 409 with `existingId`: it should update that credential instead.
- **Consumers:** identity is (credential, consumer), compared case- and space-insensitively (unique index). Re-observing a consumer updates that row and never adds a second one.
- **Checks:** each check is an observation. A new Idempotency-Key is a new row; a retry under the same key returns the first row.
- **Idempotency-Key** (header, required for the agent): the first response for (actor, key) is stored in `ops.credential_requests` within the same transaction. A retry with the same request replays it with `replayed: true`. The same key on a different request gets a 409. A failed request stores nothing, so its key can be retried.

**Stale writes.** Each credential has a `version`, which every mutation of it moves on, including changes to its consumers and checks. Agent updates and consumer writes must send `ifVersion`. If it doesn't match, the agent gets a 409 with `currentVersion`. That is how a sweep is kept from overwriting a newer owner correction. The owner's app doesn't send `ifVersion`, so its writes always apply.

**Evidence levels.** `field_provenance` records the level, actor and time for each field:
- `provider_verified`: seen at the provider or host. Claude states this; it is not independently proven.
- `owner_confirmed`: the owner wrote it.
- `inferred`.

The agent sends `evidence: {level: provider_verified | inferred, note}`. It can never claim `owner_confirmed`. Rules for the agent:
- It may not overwrite a field backed by a stronger level. `owner_confirmed` is the strongest, so the agent never overwrites an owner-set field. Values entered before managed writes have no provenance and count as owner-set. Empty fields can be filled.
- Sending the same value with a stronger level upgrades the provenance. Sending the same value at an equal or weaker level is a no-op: no event and no version change.
- It may not remove a deadline (`null`, `"none"` or `""`).
- Extending a deadline needs `provider_verified`. Moving one earlier on `inferred` evidence is allowed, because it only warns sooner.
- Confirming a consumer needs `provider_verified`. It never downgrades or removes one.
- Unknown body fields are a 400. This blocks indirect retire or ownership changes through a PATCH, such as `removed_at`, `managed_by` or `status`.

Retire and consumer removal are owner-only. They are blocked by the allowlist, and `src/credentials.ts` refuses them for the agent as well.

**Secrets.** Evidence notes go through the same `ops.looks_like_secret` check as other free text. Snapshots contain only tracked columns, and their `secret_ref` must pass the frozen `ops.secret_ref_ok_v1` (DB CHECK `credential_events_secret_ref_v1`).

**Tests.** `scripts/test-credentials-managed.ts` covers concurrent creates under one key, concurrent updates from one version, stale sweep vs owner correction, injected audit failure (full rollback, key not burned), evidence downgrade, indirect retire/deadline removal, consumer and check identity, secret refusal, the audit trail and revocation. These mutations are each caught: no version check, deadline removal allowed, no evidence ranking, swallowed audit errors, the extension rule removed.

**Where it runs.** Live agent writes come from claude.ai/code sessions in the dedicated cloud environment that holds the network secret. Project chats don't receive network secrets (Agent Hub: `credential-watch/token-delivery-2026-11-27.md`).
