/** Netlify may send the body as base64. */
export function decodeRequestBody(event) {
  if (event.isBase64Encoded) {
    return Buffer.from(event.body || "", "base64").toString("utf8");
  }
  return event.body || "";
}

export function getHeader(event, headerName) {
  const headers = event.headers || {};
  const targetName = headerName.toLowerCase();

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === targetName) {
      return Array.isArray(value) ? value[0] : value;
    }
  }

  return undefined;
}

export function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
