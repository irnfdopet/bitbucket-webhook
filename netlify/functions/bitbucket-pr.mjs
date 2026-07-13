import { EXPECTED_REPO, PR_CREATED_EVENT } from "./lib/constants.mjs";
import {
  getRepositoryFullName,
  isValidBitbucketSignature,
} from "./lib/bitbucket.mjs";
import {
  decodeRequestBody,
  getHeader,
  jsonResponse,
} from "./lib/http.mjs";
import {
  buildReviewerMentions,
  buildSlackMessage,
  postSlackMessage,
} from "./lib/slack.mjs";

/**
 * Receives Bitbucket PR webhooks and posts a Slack notification.
 *
 * @param {import('@netlify/functions').HandlerEvent} event
 * @returns {Promise<import('@netlify/functions').HandlerResponse>}
 */
export async function handler(event) {
  if (event.httpMethod === "GET") {
    return jsonResponse(200, {
      ok: true,
      message: "Bitbucket PR webhook endpoint. POST pullrequest:created events here.",
    });
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!slackWebhookUrl) {
    console.error("SLACK_WEBHOOK_URL is not configured");
    return jsonResponse(500, { error: "Server misconfigured" });
  }

  const requestBody = decodeRequestBody(event);

  const bitbucketWebhookSecret = process.env.BITBUCKET_WEBHOOK_SECRET;
  if (bitbucketWebhookSecret) {
    const signatureHeader = getHeader(event, "x-hub-signature");
    if (
      !isValidBitbucketSignature(
        requestBody,
        signatureHeader,
        bitbucketWebhookSecret
      )
    ) {
      return jsonResponse(401, { error: "Invalid signature" });
    }
  }

  let webhookPayload;
  try {
    webhookPayload = JSON.parse(requestBody);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const bitbucketEvent =
    getHeader(event, "x-event-key") || webhookPayload.eventKey || "";

  // 200 so Bitbucket does not keep retrying ignored events.
  if (bitbucketEvent && bitbucketEvent !== PR_CREATED_EVENT) {
    return jsonResponse(200, {
      ok: true,
      ignored: true,
      reason: `Unhandled event: ${bitbucketEvent}`,
    });
  }

  const repositoryFullName = getRepositoryFullName(webhookPayload.repository);
  if (repositoryFullName && repositoryFullName !== EXPECTED_REPO) {
    return jsonResponse(200, {
      ok: true,
      ignored: true,
      reason: `Unexpected repository: ${repositoryFullName}`,
    });
  }

  const pullRequest = webhookPayload.pullrequest;
  if (!pullRequest) {
    return jsonResponse(400, { error: "Missing pullrequest in payload" });
  }

  const openedBy =
    webhookPayload.actor?.display_name ||
    webhookPayload.actor?.nickname ||
    "Someone";
  const pullRequestTitle = pullRequest.title || "Untitled PR";
  const pullRequestId = pullRequest.id;
  const authorName =
    pullRequest.author?.display_name ||
    pullRequest.author?.nickname ||
    openedBy;
  const sourceBranch = pullRequest.source?.branch?.name || "unknown";
  const destinationBranch = pullRequest.destination?.branch?.name || "unknown";
  const pullRequestUrl =
    pullRequest.links?.html?.href ||
    `https://bitbucket.org/${EXPECTED_REPO}/pull-requests/${pullRequestId}`;
  const reviewerMentions = await buildReviewerMentions(pullRequest);

  const slackMessage = buildSlackMessage({
    pullRequestTitle,
    pullRequestId,
    pullRequestUrl,
    authorName,
    sourceBranch,
    destinationBranch,
    openedBy,
    reviewerMentions,
  });

  const notified = await postSlackMessage(slackWebhookUrl, slackMessage);
  if (!notified) {
    return jsonResponse(502, { error: "Failed to notify Slack" });
  }

  return jsonResponse(200, {
    ok: true,
    notified: true,
    pullRequest: pullRequestId,
  });
}
