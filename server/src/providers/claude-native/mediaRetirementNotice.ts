export function mediaRetirementNotice(images: number, documents: number): string | undefined {
  const parts: string[] = [];
  if (images > 0) parts.push(`${images} old image${images === 1 ? '' : 's'}`);
  if (documents > 0) parts.push(`${documents} old PDF document${documents === 1 ? '' : 's'}`);
  if (!parts.length) return undefined;
  const receipt = images + documents === 1 ? 'a text receipt' : 'text receipts';
  return `Replaced ${parts.join(' and ')} with ${receipt} to make room for new media. Attach or request a file again to bring it back.`;
}
