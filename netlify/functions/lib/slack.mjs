import { EXPECTED_REPO } from "./constants.mjs";
import { getAssignedReviewers } from "./bitbucket.mjs";

export function escapeSlackText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Reviewer mentions for Slack.
 * 1. SLACK_MEMBER_ID (comma-separated) — temporary test override
 * 2. Else email lookup via SLACK_BOT_TOKEN + COMPANY_EMAIL_DOMAIN
 * 3. Else Bitbucket display names
 */
export async function buildReviewerMentions(pullRequest) {
  const hardcodedMentions = getHardcodedSlackMentions();
  if (hardcodedMentions) {
    console.log("[reviewers] using SLACK_MEMBER_ID override:", hardcodedMentions);
    return hardcodedMentions;
  }

  const hasBotToken = Boolean(process.env.SLACK_BOT_TOKEN);
  const emailDomain = (process.env.COMPANY_EMAIL_DOMAIN || "").trim();
  console.log("[reviewers] lookup config", {
    hasBotToken,
    emailDomain: emailDomain || "(missing)",
  });

  const reviewers = getAssignedReviewers(pullRequest);
  console.log(
    "[reviewers] from Bitbucket:",
    reviewers.map((r) => ({
      display_name: r.display_name,
      nickname: r.nickname,
      username: r.username,
      email: r.email_address || r.email || null,
    }))
  );

  if (reviewers.length === 0) return "_none assigned_";

  const mentions = await Promise.all(
    reviewers.map((reviewer) => resolveSlackMention(reviewer))
  );
  console.log("[reviewers] final mentions:", mentions);
  return mentions.join(", ");
}

export function buildSlackMessage({
  pullRequestTitle,
  pullRequestId,
  pullRequestUrl,
  authorName,
  sourceBranch,
  destinationBranch,
  openedBy,
  reviewerMentions,
}) {
  return [
    `*New pull request in \`${EXPECTED_REPO}\`*. Please review when you have a moment:\n`,
    `*<${pullRequestUrl}|#${pullRequestId}: ${escapeSlackText(pullRequestTitle)}>*`,
    `• Author: ${escapeSlackText(authorName)}`,
    `• Branch: ${escapeSlackText(sourceBranch)} → ${escapeSlackText(destinationBranch)}`,
    `• Opened by: ${escapeSlackText(openedBy)}`,
    `• Reviewers: ${reviewerMentions}`,
  ].join("\n");
}

export async function postSlackMessage(slackWebhookUrl, slackMessage) {
  const slackResponse = await fetch(slackWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: slackMessage,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });

  if (!slackResponse.ok) {
    const errorDetail = await slackResponse.text();
    console.error("Slack webhook failed", slackResponse.status, errorDetail);
    return false;
  }

  return true;
}

function getHardcodedSlackMentions() {
  const memberIds = (process.env.SLACK_MEMBER_ID || "")
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);

  if (memberIds.length === 0) return null;
  return memberIds.map((memberId) => `<@${memberId}>`).join(", ");
}

async function resolveSlackMention(reviewer) {
  const displayName =
    reviewer.display_name ||
    reviewer.nickname ||
    reviewer.username ||
    "Unknown";

  const email = guessReviewerEmail(reviewer);
  if (!email) {
    console.warn("[reviewers] no email for", displayName, "- falling back to name");
    return escapeSlackText(displayName);
  }

  console.log("[reviewers] looking up Slack user for", displayName, "→", email);
  const slackMemberId = await lookupSlackMemberIdByEmail(email);
  if (!slackMemberId) {
    console.warn("[reviewers] no Slack match for", email, "- falling back to name");
    return escapeSlackText(displayName);
  }

  console.log("[reviewers] matched", email, "→", slackMemberId);
  return `<@${slackMemberId}>`;
}

/** Prefer payload email; else `{nickname}@{COMPANY_EMAIL_DOMAIN}`. */
function guessReviewerEmail(reviewer) {
  const emailFromPayload = reviewer.email_address || reviewer.email;
  if (emailFromPayload) {
    return String(emailFromPayload).trim().toLowerCase();
  }

  const emailDomain = (process.env.COMPANY_EMAIL_DOMAIN || "")
    .trim()
    .replace(/^@/, "");
  const emailLocalPart = (reviewer.nickname || reviewer.username || "")
    .trim()
    .toLowerCase();

  if (!emailDomain || !emailLocalPart) return null;
  return `${emailLocalPart}@${emailDomain}`;
}

/** Requires SLACK_BOT_TOKEN with users:read.email. */
async function lookupSlackMemberIdByEmail(email) {
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  if (!slackBotToken) return null;

  try {
    const lookupUrl = new URL("https://slack.com/api/users.lookupByEmail");
    lookupUrl.searchParams.set("email", email);

    const response = await fetch(lookupUrl, {
      headers: { Authorization: `Bearer ${slackBotToken}` },
    });
    const result = await response.json();

    if (!result.ok) {
      console.warn("Slack users.lookupByEmail failed", email, result.error);
      return null;
    }

    return result.user?.id || null;
  } catch (error) {
    console.error("Slack users.lookupByEmail error", email, error);
    return null;
  }
}
