import { useAppStore } from '../stores/appStore';
import { HeaderDropdown, type HeaderMenuItem } from './HeaderDropdown';

/** Top-bar HELP menu: contextual help mode, the user manual and the keyboard shortcuts. */
export function HelpMenu() {
  const helpMode = useAppStore((s) => s.helpMode);
  const setHelpMode = useAppStore((s) => s.setHelpMode);
  const setShowManual = useAppStore((s) => s.setShowManual);
  const items: HeaderMenuItem[] = [
    { key: 'point', label: helpMode ? 'EXIT POINT AT THINGS' : 'POINT AT THINGS', icon: '?', onClick: () => setHelpMode(!helpMode), dataHelp: 'help.toggle', active: helpMode, title: helpMode ? 'Exit help mode (Esc)' : 'Contextual help: click any control to see what it does' },
    { key: 'manual', label: 'USER MANUAL', icon: '\u24D8', onClick: () => setShowManual(true), dataHelp: 'header.manual', title: 'User manual: every feature, every quirk' },
    { key: 'shortcuts', label: 'KEYBOARD SHORTCUTS', icon: '\u2328', onClick: () => window.dispatchEvent(new CustomEvent('arco:open-shortcuts')), dataHelp: 'header.shortcuts', title: 'Keyboard shortcuts (Ctrl or Cmd + ?)' },
  ];
  return <HeaderDropdown label="HELP" icon={'\u24D8'} items={items} dataHelp="header.help" title="Help: point at things, user manual, keyboard shortcuts" />;
}
