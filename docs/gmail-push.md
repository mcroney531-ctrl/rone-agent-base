# Gmail push: one-time setup

Inbox Triage wakes within seconds of new mail instead of waiting up to 20 minutes. Gmail publishes "inbox changed" to a Pub/Sub topic, and a push subscription POSTs to the worker's `/ingress/gmail`. Design and guarantees: `docs/closeout.md` → *External event ingress*.

Do this in the Google Cloud project that holds the app's OAuth client.

1. **Turn on Pub/Sub.** APIs & Services → Enable APIs → **Cloud Pub/Sub API** → Enable.
2. **Create the topic.** Pub/Sub → Topics → Create topic.
   - ID: `agent-ops-gmail`.
   - Untick "Add a default subscription".
   - The full name is `projects/<project-id>/topics/agent-ops-gmail`.
3. **Let Gmail publish to it.** Open the topic → Permissions → Add principal.
   - Principal: `gmail-api-push@system.gserviceaccount.com`.
   - Role: **Pub/Sub Publisher**.
4. **Create a service account for push authentication.** IAM & Admin → Service accounts → Create.
   - Name: `agent-ops-push`.
   - Grant no roles.
   - Its email is `agent-ops-push@<project-id>.iam.gserviceaccount.com`.
5. **Create the push subscription.** Pub/Sub → Subscriptions → Create.
   - Topic: `agent-ops-gmail`.
   - Delivery type: **Push**. Endpoint: `https://<worker domain>/ingress/gmail`.
   - **Enable authentication**: service account `agent-ops-push`; audience = the same endpoint URL.
   - Retry policy: exponential backoff (10 s → 600 s).
   - Message retention: 7 days (the default) is fine.
   - Pub/Sub must be allowed to mint tokens for that service account. Projects created after April 2021 allow this by default. On older projects, grant the Pub/Sub service agent (`service-<project-number>@gcp-sa-pubsub.iam.gserviceaccount.com`) **Service Account Token Creator** on `agent-ops-push`.
6. **Configure the worker** (Railway variables; none are secret):
   - `GMAIL_PUSH_TOPIC` = `projects/<project-id>/topics/agent-ops-gmail`
   - `PUSH_OIDC_AUDIENCE` = `https://<worker domain>/ingress/gmail`
   - `PUSH_OIDC_EMAIL` = `agent-ops-push@<project-id>.iam.gserviceaccount.com`
7. **Start the watch.** Use Run now on Inbox Triage, or wait for the next scheduled run; either creates the watch. Check it with:
   `select * from ops.mail_push_health;` (push_state `on`, an expiration about 7 days out).
   Gmail sends one notification right after a watch is created. It shows up as a no-op push run.

## Operating it

- **Renewal:** automatic on scheduled runs, daily. A failure shows in Needs You as *Instant mail detection is off*. Triage keeps running every 20 minutes meanwhile.
- **Turning it off:** unset `GMAIL_PUSH_TOPIC`. The route answers 404, and the next scheduled run clears the watch state. Gmail's watch lapses by itself within 7 days. Deleting the subscription stops deliveries at once.
- **Events:** `select * from ops.ingress_events order by id desc limit 20;`. Each event has one row; `delivery_count > 1` means Pub/Sub redelivered it.
