import { createHmac, timingSafeEqual } from "node:crypto";

const EXPECTED_REPO = "vetstoria/rnd";
const PR_CREATED = "pullrequest:created";

/**
 * @param {import('@netlify/functions').HandlerEvent} event
 * @returns {Promise<import('@netlify/functions').HandlerResponse>}
 */
export async function handler(event) {
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

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";

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

  const eventKey =
    header(event, "x-event-key") ||
    payload.eventKey ||
    "";

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

  const text = [
    `*New pull request in \`${EXPECTED_REPO}\`*`,
    `*<${link}|#${id}: ${escapeSlack(title)}>*`,
    `• Author: ${escapeSlack(author)}`,
    `• ${escapeSlack(source)} → ${escapeSlack(destination)}`,
    `• Opened by: ${escapeSlack(actor)}`,
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
 * Bitbucket Cloud signs the body with HMAC-SHA256 when a webhook secret is set.
 * Header format: sha256=<hex digest>
 */
function verifyBitbucketSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const provided = signatureHeader.slice("sha256=".length);
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  try {
    const a = Buffer.from(provided, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function escapeSlack(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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
