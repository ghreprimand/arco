/** Delimit decoded Chat attachments so their content is attributable to a file. */
export function attachmentContentStart(name: string): string {
  return `[Attached file: ${name}]\n[Begin attachment content]`;
}
export const ATTACHMENT_CONTENT_END = '[End attachment content]';
export function wrapAttachmentContent(name: string, text: string): string {
  return `${attachmentContentStart(name)}\n${text}\n${ATTACHMENT_CONTENT_END}`;
}
