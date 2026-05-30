// Content guardrail shared by client and server.
// Blocks URLs, emails, and phone numbers so the campfire can't be used to
// trade off-platform contact info or spew spam links. The block happens on
// BOTH sides: the client gives instant feedback, the server is the real gate.

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|gg|xyz|co|me|dev|app|chat)\b/i;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
// 7+ digits with common separators — catches most phone numbers without
// nuking short numbers people might say in conversation.
const PHONE_RE = /(?:\+?\d[\s().-]?){7,}\d/;

export const ASH_MESSAGE = "[Message turned to ash by the fire]";

// Returns true if the text contains something we refuse to relay.
export function isContraband(text) {
  return URL_RE.test(text) || EMAIL_RE.test(text) || PHONE_RE.test(text);
}

// Convenience: returns the message to broadcast, or the ash placeholder.
export function sanitize(text) {
  return isContraband(text) ? ASH_MESSAGE : text;
}
