// The binary emits either a numeric build or a semantic version plus build/commit.
export function parseLlamacppVersion(text: string): string | undefined {
  return /^\s*version:[ \t]*([^\r\n]+)/im.exec(text)?.[1]?.trim();
}
