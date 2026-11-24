// docs/RESEARCH.md - exports.md in the research folder records where results
// went, one line per export: "- <time> - <kind> - destination: <where>".
// SEND TO A PROJECT reads it to open on the project folder used last.

const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])/;

function sameFolder(a: string, b: string): boolean {
  const trim = (path: string) => path.replace(/[\\/]+$/, '');
  return trim(a) === trim(b);
}

// The project folder of the most recent export that named one: a folder copy
// ("<project>/research/<name>") or a started project ("started project
// <project>"). Plan references, drafts, downloads and reruns name no folder.
// The research folder itself is never a destination.
export function lastProjectFolder(exportsText: string, researchFolder: string): string | undefined {
  const lines = exportsText.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const where = /^- \S+ - \S+ - destination: (.+)$/.exec(lines[i]!.trim())?.[1]?.trim();
    if (!where) continue;
    const started = /^started project (.+)$/.exec(where)?.[1];
    const folder = started ?? /^(.+)[\\/]research[\\/][^\\/]+$/.exec(where)?.[1];
    if (folder && ABSOLUTE.test(folder) && !sameFolder(folder, researchFolder)) return folder;
  }
  return undefined;
}
