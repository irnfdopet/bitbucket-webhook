import { createHmac, timingSafeEqual } from "node:crypto";

/** Bitbucket signs with HMAC-SHA256: `X-Hub-Signature: sha256=<hex>`. */
export function isValidBitbucketSignature(
  requestBody,
  signatureHeader,
  webhookSecret
) {
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const providedSignature = signatureHeader.slice("sha256=".length);
  const expectedSignature = createHmac("sha256", webhookSecret)
    .update(requestBody, "utf8")
    .digest("hex");

  try {
    const providedBuffer = Buffer.from(providedSignature, "hex");
    const expectedBuffer = Buffer.from(expectedSignature, "hex");
    return (
      providedBuffer.length === expectedBuffer.length &&
      timingSafeEqual(providedBuffer, expectedBuffer)
    );
  } catch {
    return false;
  }
}

export function getRepositoryFullName(repository = {}) {
  if (repository.full_name) return repository.full_name;

  const workspace =
    repository.workspace?.slug || repository.owner?.username;
  const repoName = repository.name;

  return [workspace, repoName].filter(Boolean).join("/");
}

export function getAssignedReviewers(pullRequest) {
  if (Array.isArray(pullRequest.reviewers) && pullRequest.reviewers.length > 0) {
    return pullRequest.reviewers;
  }

  if (!Array.isArray(pullRequest.participants)) return [];

  return pullRequest.participants
    .filter((participant) => participant?.role === "REVIEWER")
    .map((participant) => participant.user)
    .filter(Boolean);
}
