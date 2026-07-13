import { createHmac, timingSafeEqual } from "node:crypto";

/** Only process PRs from this Bitbucket workspace/repo. */
const EXPECTED_REPO = "vetstoria/rnd";

/** Bitbucket Cloud event key for a newly opened pull request. */
const PR_CREATED = "pullrequest:created";

/**
 * Netlify Function entrypoint.
 * Bitbucket POSTs here on PR create; we forward a short summary to Slack.
 *
 * @param {import('@netlify/functions').HandlerEvent} event
 * @returns {Promise<import('@netlify/functions').HandlerResponse>}
 */
export async function handler(event) {
  // Health check / browser probe — confirms the route is live.
  if (event.httpMethod === "GET") {
    return json(200, {
      ok: true,
      message: "Bitbucket PR webhook endpoint. POST pullrequest:created events here.",
    });
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!slackWebhookUrl) {
    console.error("SLACK_WEBHOOK_URL is not configured");
    return json(500, { error: "Server misconfigured" });
  }

  // Netlify may base64-encode the body; always work from a UTF-8 string for HMAC + JSON.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";

  // If a secret is configured, reject unsigned or tampered requests.
  const webhookSecret = process.env.BITBUCKET_WEBHOOK_SECRET;
  if (webhookSecret) {
    const signature = header(event, "x-hub-signature");
    if (!verifyBitbucketSignature(rawBody, signature, webhookSecret)) {
      return json(401, { error: "Invalid signature" });
    }
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  // Prefer the X-Event-Key header Bitbucket sends; payload.eventKey is a fallback.
  const eventKey =
    header(event, "x-event-key") ||
    payload.eventKey ||
    "";

  // Return 200 for ignored events so Bitbucket does not retry them.
  if (eventKey && eventKey !== PR_CREATED) {
    return json(200, { ok: true, ignored: true, reason: `Unhandled event: ${eventKey}` });
  }

  const repository = payload.repository || {};
  const fullName =
    repository.full_name ||
    [repository.workspace?.slug || repository.owner?.username, repository.name]
      .filter(Boolean)
      .join("/");

  if (fullName && fullName !== EXPECTED_REPO) {
    return json(200, {
      ok: true,
      ignored: true,
      reason: `Unexpected repository: ${fullName}`,
    });
  }

  const pr = payload.pullrequest;
  if (!pr) {
    return json(400, { error: "Missing pullrequest in payload" });
  }

  // Flatten the PR fields we care about for the Slack message.
  const actor = payload.actor?.display_name || payload.actor?.nickname || "Someone";
  const title = pr.title || "Untitled PR";
  const id = pr.id;
  const author =
    pr.author?.display_name || pr.author?.nickname || actor;
  const source = pr.source?.branch?.name || "unknown";
  const destination = pr.destination?.branch?.name || "unknown";
  const link =
    pr.links?.html?.href ||
    `https://bitbucket.org/${EXPECTED_REPO}/pull-requests/${id}`;
  const reviewers = await formatReviewers(pr);

  const text = [
    `*New pull request in \`${EXPECTED_REPO}\`*. Please review when you have a moment:\n`,
    `*<${link}|#${id}: ${escapeSlack(title)}>*`,
    `• Author: ${escapeSlack(author)}`,
    `• Branch: ${escapeSlack(source)} → ${escapeSlack(destination)}`,
    `• Opened by: ${escapeSlack(actor)}`,
    `• Reviewers: ${reviewers}`,
  ].join("\n");

  const slackResponse = await fetch(slackWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });

  if (!slackResponse.ok) {
    const detail = await slackResponse.text();
    console.error("Slack webhook failed", slackResponse.status, detail);
    return json(502, { error: "Failed to notify Slack" });
  }

  return json(200, { ok: true, notified: true, pullRequest: id });
}

/**
 * Case-insensitive header lookup (Netlify may normalize header names differently).
 *
 * @param {import('@netlify/functions').HandlerEvent} event
 * @param {string} name
 */
function header(event, name) {
  const headers = event.headers || {};
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

/**
 * Verify Bitbucket Cloud HMAC-SHA256 signature when a webhook secret is set.
 * Expected header format: `X-Hub-Signature: sha256=<hex digest>`
 */
function verifyBitbucketSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const provided = signatureHeader.slice("sha256=".length);
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  // timingSafeEqual avoids leaking how much of the signature matched.
  try {
    const a = Buffer.from(provided, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Escape characters that Slack treats specially inside message text. */
function escapeSlack(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Build a comma-separated reviewer list for Slack.
 * Uses `pullrequest.reviewers`, or participants with role REVIEWER as a fallback.
 *
 * When SLACK_BOT_TOKEN + COMPANY_EMAIL_DOMAIN are set, resolves each reviewer to a
 * Slack member ID via email (nickname@domain) and posts a real @mention.
 */
async function formatReviewers(pr) {
  // Temporary override: comma-separated Slack member IDs (skips email lookup).
  const hardcodedMentions = formatHardcodedMemberMentions();
  if (hardcodedMentions) return hardcodedMentions;

  const fromReviewers = Array.isArray(pr.reviewers) ? pr.reviewers : [];
  const fromParticipants = Array.isArray(pr.participants)
    ? pr.participants
        .filter((p) => p?.role === "REVIEWER")
        .map((p) => p.user)
        .filter(Boolean)
    : [];

  const users = fromReviewers.length > 0 ? fromReviewers : fromParticipants;
  if (users.length === 0) return "_none assigned_";

  const mentions = await Promise.all(users.map((user) => resolveReviewerMention(user)));
  return mentions.join(", ");
}

/**
 * Parse SLACK_MEMBER_ID as one or more IDs separated by commas or spaces.
 * Example: U09FCP6R402,U012ABCDEF
 */
function formatHardcodedMemberMentions() {
  const raw = (process.env.SLACK_MEMBER_ID || "").trim();
  if (!raw) return null;

  const ids = raw.split(/[\s,]+/).map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return null;

  return ids.map((id) => `<@${id}>`).join(", ");
}

/**
 * Prefer a real Slack @mention when we can map Bitbucket → company email → Slack user.
 * Falls back to display name when lookup is unavailable or fails.
 */
async function resolveReviewerMention(user) {
  const display =
    user.display_name || user.nickname || user.username || "Unknown";

  const email = guessCompanyEmail(user);
  if (!email) return escapeSlack(display);

  const slackUserId = await lookupSlackUserIdByEmail(email);
  if (!slackUserId) return escapeSlack(display);

  // Slack notifies the user when the message contains <@MEMBER_ID>.
  return `<@${slackUserId}>`;
}

/**
 * Bitbucket webhooks rarely include email. If both products use the same company
 * address, build it as `{nickname|username}@{COMPANY_EMAIL_DOMAIN}`.
 * Also accepts email_address / email when Bitbucket does send them.
 */
function guessCompanyEmail(user) {
  const explicit = user.email_address || user.email;
  if (explicit) return String(explicit).trim().toLowerCase();

  const domain = (process.env.COMPANY_EMAIL_DOMAIN || "").trim().replace(/^@/, "");
  const local = (user.nickname || user.username || "").trim().toLowerCase();
  if (!domain || !local) return null;

  return `${local}@${domain}`;
}

/**
 * Slack Web API: users.lookupByEmail
 * Requires SLACK_BOT_TOKEN with users:read.email (and email visible on the Slack profile).
 */
async function lookupSlackUserIdByEmail(email) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return null;

  try {
    const url = new URL("https://slack.com/api/users.lookupByEmail");
    url.searchParams.set("email", email);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();

    if (!data.ok) {
      console.warn("Slack users.lookupByEmail failed", email, data.error);
      return null;
    }

    return data.user?.id || null;
  } catch (error) {
    console.error("Slack users.lookupByEmail error", email, error);
    return null;
  }
}

/**
 * @param {number} statusCode
 * @param {Record<string, unknown>} body
 */
function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
