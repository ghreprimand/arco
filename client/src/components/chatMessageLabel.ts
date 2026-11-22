export function assistantLabel(chatPresentation: boolean, passthrough: boolean, antigravity: boolean): string {
  if (chatPresentation) return 'ARCO';
  return passthrough && !antigravity ? '< ARCO :: PASSTHROUGH' : '< ARCO';
}
