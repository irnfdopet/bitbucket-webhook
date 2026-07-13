# Bitbucket → Slack PR notifier

Small Netlify app that receives Bitbucket webhooks for **pull request created** events in [`vetstoria/rnd`](https://bitbucket.org/vetstoria/rnd) and posts a message to Slack `#test-bb`.

## How it works

```
Bitbucket (PR created) → POST /webhook → Netlify Function → Slack Incoming Webhook → #test-bb
```

## 1. Create a Slack Incoming Webhook

1. Open [Slack API apps](https://api.slack.com/apps) → **Create New App** → **From scratch**.
2. Choose your workspace.
3. Go to **Incoming Webhooks** → turn them **On**.
4. Click **Add New Webhook to Workspace**.
5. Select channel **`#test-bb`** → **Allow**.
6. Copy the Incoming Webhook URL Slack shows you.

## 2. Deploy to Netlify

1. Push this repo to GitHub (already pointed at `origin`).
2. In Netlify: **Add new site** → **Import an existing project** → select this repo.
3. Build settings can stay as in `netlify.toml` (publish `public`, functions in `netlify/functions`).
4. Site settings → **Environment variables** → add:

| Variable | Required | Value |
|---|---|---|
| `SLACK_WEBHOOK_URL` | Yes | Slack Incoming Webhook URL from step 1 |
| `BITBUCKET_WEBHOOK_SECRET` | Recommended | Long random string (same value you will set in Bitbucket) |

5. Deploy the site. Note your site URL, e.g. `https://your-site.netlify.app`.

Webhook URL to use in Bitbucket:

```text
https://your-site.netlify.app/webhook
```

## 3. Add the Bitbucket webhook

1. Open [vetstoria/rnd](https://bitbucket.org/vetstoria/rnd) → **Repository settings** → **Webhooks** → **Add webhook**.
2. Fill in:
   - **Title:** `Slack PR notifications`
   - **URL:** `https://your-site.netlify.app/webhook`
   - **Secret:** same value as `BITBUCKET_WEBHOOK_SECRET` (if set)
   - **Status:** Active
   - **Triggers:** choose **Choose from a full list of triggers** → under Pull Request select **Created** only
3. Save.

## 4. Verify

1. Open `https://your-site.netlify.app/webhook` in a browser — you should see a small JSON health response.
2. Create a test pull request in `vetstoria/rnd`.
3. Confirm a message appears in `#test-bb`.

## Local development

```bash
cp .env.example .env
# fill in SLACK_WEBHOOK_URL (and optional BITBUCKET_WEBHOOK_SECRET)

npm install -g netlify-cli   # if needed
netlify dev
```

Then POST a sample payload:

```bash
curl -X POST http://localhost:8888/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-Event-Key: pullrequest:created' \
  -d '{
    "actor": { "display_name": "Imran" },
    "repository": { "full_name": "vetstoria/rnd" },
    "pullrequest": {
      "id": 1,
      "title": "Test PR",
      "author": { "display_name": "Imran" },
      "source": { "branch": { "name": "feature/test" } },
      "destination": { "branch": { "name": "main" } },
      "links": { "html": { "href": "https://bitbucket.org/vetstoria/rnd/pull-requests/1" } }
    }
  }'
```

## Notes

- Non-`pullrequest:created` events are ignored with `200` so Bitbucket does not retry them.
- Events for any repository other than `vetstoria/rnd` are ignored.
- If `BITBUCKET_WEBHOOK_SECRET` is set, requests must include a valid `X-Hub-Signature: sha256=...` header.
