// Preserve sentence punctuation and let the voice see complete phrases. A
// character-count split in the middle of a sentence destroys its prosody.
export function voiceSpeechChunks(message: string): string[] {
  const text = message.replace(/```[\s\S]*?```/g, ' Code block omitted. ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`#]/g, '')
    .replace(/\n\s*[-•]\s+/g, '\n').slice(0, 5000).trim();
  const chunks: string[] = [];
  const sentences = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)].map((s) => s.segment.trim());
  for (let i = 0; i < sentences.length; i++) {
    let rest = sentences[i];
    while (/\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|e\.g|i\.e)\.$/i.test(rest) && i + 1 < sentences.length) rest += ' ' + sentences[++i];
    while (rest.length > 480) {
      const prefix = rest.slice(0, 480);
      const phrase = [...prefix.matchAll(/[,;:]\s+/g)].at(-1);
      const boundary = phrase?.index !== undefined && phrase.index > 120 ? phrase.index + 1 : prefix.lastIndexOf(' ');
      const end = boundary > 0 ? boundary : 480;
      chunks.push(rest.slice(0, end).trim()); rest = rest.slice(end).trim();
    }
    if (rest) chunks.push(rest);
  }
  return chunks;
}
