import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { useAppStore } from './stores/appStore';
import { useDraftStore } from './stores/draftStore';
import { hasUnsavedWork, reportRecovery, startRecoveryGuard, useBuildStore } from './buildCheck';

// A restart may reload a page that has nothing unsaved. A draft, an edited
// field, an open dialog, an attachment, an incognito tab, or a focused editor
// must leave the reload prompt up and must not call reload.

test('a page with unsaved work never auto-reloads', async () => {
  const virtualConsole = new VirtualConsole();
  let navigated = 0;
  virtualConsole.on('jsdomError', (err: Error) => { if (err.message.includes('navigation')) navigated += 1; });
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true, virtualConsole });
  const globals = Object.getOwnPropertyDescriptors(globalThis);
  const before = useAppStore.getState();
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    sessionStorage: { configurable: true, value: dom.window.sessionStorage },
    localStorage: { configurable: true, value: dom.window.localStorage },
    Element: { configurable: true, value: dom.window.Element },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  mock.timers.enable({ apis: ['setTimeout'] });
  startRecoveryGuard();
  // jsdom's location.reload cannot be replaced. A real reload throws there;
  // a blocked recovery does not.
  const fire = () => {
    const before = navigated;
    reportRecovery('build');
    mock.timers.tick(1000);
    return navigated - before;
  };
  try {
    useDraftStore.setState({ drafts: {}, tidyUndo: {} });
    useAppStore.setState({ jobs: {}, attachments: {} });
    useBuildStore.setState({ stale: false, reason: null });
    assert.equal(hasUnsavedWork(), false);
    assert.equal(fire(), 1, 'a clean page reloads once');
    assert.equal(useBuildStore.getState().stale, true);
    assert.equal(fire(), 0, 'a second recovery inside a minute does not reload again');

    sessionStorage.clear();
    useDraftStore.getState().setDraft('tab', 'unsaved note');
    assert.equal(fire(), 0);
    assert.equal(useBuildStore.getState().stale, true);
    useDraftStore.getState().setDraft('tab', ' ');
    assert.equal(hasUnsavedWork(), true);
    useDraftStore.getState().clearDraft('tab');

    const field = document.createElement('textarea');
    document.body.append(field);
    field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
    assert.equal(hasUnsavedWork(), true);
    assert.equal(fire(), 0, 'an edited field blocks the reload');
    field.remove();
    assert.equal(hasUnsavedWork(), false);

    const composer = document.createElement('textarea');
    composer.setAttribute('data-recovery-composer', '');
    document.body.append(composer);
    composer.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
    assert.equal(hasUnsavedWork(), false, 'the composer is tracked through its draft, not the input event');
    reportRecovery('session');
    useDraftStore.getState().setDraft('tab', 'typed while the timer was waiting');
    const during = navigated;
    mock.timers.tick(1000);
    assert.equal(navigated, during, 'work that appears before the timer fires is not discarded');
    useDraftStore.getState().clearDraft('tab');
    composer.remove();

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    assert.equal(fire(), 0);
    dialog.remove();

    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.append(editor);
    editor.tabIndex = 0;
    editor.focus();
    assert.equal(fire(), 0);
    editor.blur();
    editor.remove();

    useAppStore.setState({ attachments: { tab: [{ name: 'note.txt' }] } as never });
    assert.equal(fire(), 0);
    useAppStore.setState({ attachments: {}, jobs: { tab: { config: { incognito: true } } } as never });
    assert.equal(fire(), 0, 'an incognito tab is not thrown away by a reload');
    useAppStore.setState({ jobs: {} });
    sessionStorage.clear();
    assert.equal(fire(), 1);
  } finally {
    useDraftStore.setState({ drafts: {}, tidyUndo: {} });
    useAppStore.setState(before, true);
    useBuildStore.setState({ stale: false, reason: null });
    mock.timers.reset();
    for (const name of ['window', 'document', 'sessionStorage', 'localStorage', 'Element', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (globals[name]) Object.defineProperty(globalThis, name, globals[name]);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
});
