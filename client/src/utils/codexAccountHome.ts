// The folder a Codex account profile signs in under. A profile with its own
// CODEX_HOME shows that folder. A profile without one uses a folder the server
// chooses inside Arco's data folder, which the client cannot know, so it is
// named rather than guessed. It never shows the default Codex home, which
// would suggest the profile shares the default sign-in.
export function codexProfileHomeLabel(profile: { codexHome?: string }): string {
  const home = profile.codexHome?.trim();
  return home ? home : 'Arco data folder';
}
