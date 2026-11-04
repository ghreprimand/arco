// Conservative acknowledgement-only classification. Unknown text remains actionable.
const ACK = /^(?:thanks|thank you|ack|acknowledged|received|got it|noted|ok|okay|on it|standing by|will do|sounds good|no action needed|nothing to do|done here|idle|waiting)[.!\s]*$/i;

export function isAutoPickupAcknowledgement(body: string): boolean {
  const text = body.trim();
  return text.length > 0 && text.length <= 160 && !text.includes('?') && ACK.test(text);
}
