// TEST DESKTOP in Settings > Notifications. Asks the browser for permission
// itself when it has not been asked, then shows one test notification and
// reports what happened in words the operator can act on.

export type DesktopTestResult = 'sent' | 'blocked' | 'not-allowed' | 'unsupported' | 'failed';

export interface DesktopTestOutcome { result: DesktopTestResult; label: string; detail: string }

interface NotificationLike {
  onshow?: ((this: unknown, ev: unknown) => unknown) | null;
  onerror?: ((this: unknown, ev: unknown) => unknown) | null;
}
export interface NotificationApi {
  permission: string;
  requestPermission: (callback?: (p: string) => void) => Promise<string> | void;
  new (title: string, options?: { body?: string; tag?: string }): NotificationLike;
}

const BLOCKED_DETAIL = 'The browser is blocking notifications from Arco. Open the site settings (the icon at the left of the address bar, or the browser\'s settings for this site), set Notifications to Allow, then reload Arco and test again. In an app window that has its own browser profile, change the setting in that profile.';
const SENT_DETAIL = 'Test sent to the system. If nothing appeared, check the system\'s notification service and do-not-disturb setting. Normal alerts appear only while Arco is unfocused, and finished turns must run at least 15 seconds.';

export const DESKTOP_TEST_LABEL: Record<DesktopTestResult, string> = {
  sent: 'Sent',
  blocked: 'Blocked',
  'not-allowed': 'Not allowed',
  unsupported: 'Not supported',
  failed: 'Failed',
};

function outcome(result: DesktopTestResult, detail: string): DesktopTestOutcome {
  return { result, label: DESKTOP_TEST_LABEL[result], detail };
}

// Older browsers take a callback instead of returning a promise.
function askPermission(api: NotificationApi): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (p: string) => { if (!settled) { settled = true; resolve(p); } };
    try {
      const r = api.requestPermission(done);
      if (r && typeof (r as Promise<string>).then === 'function') (r as Promise<string>).then(done, () => done(api.permission));
    } catch { done(api.permission); }
  });
}

export async function runDesktopTest(api: NotificationApi | undefined, waitMs = 1500): Promise<DesktopTestOutcome> {
  if (!api) return outcome('unsupported', 'This browser does not support desktop notifications. The BELL in the top bar still shows notices.');
  let permission = api.permission;
  if (permission === 'default') permission = await askPermission(api);
  if (permission === 'denied') return outcome('blocked', BLOCKED_DETAIL);
  if (permission !== 'granted') return outcome('not-allowed', 'The browser did not allow notifications; the request was closed without an answer. Select TEST DESKTOP again and choose Allow.');
  let n: NotificationLike;
  try {
    n = new api('Arco notification test', { body: 'Desktop notifications are available.', tag: 'arco-desktop-test' });
  } catch {
    return outcome('failed', 'The browser could not show the test notification. Check its site settings and the system\'s notification settings.');
  }
  // The browser reports show or error when the system takes the notification;
  // some browsers report neither, so a quiet wait counts as sent.
  const shown = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), waitMs);
    n.onshow = () => { clearTimeout(timer); resolve(true); };
    n.onerror = () => { clearTimeout(timer); resolve(false); };
  });
  return shown
    ? outcome('sent', SENT_DETAIL)
    : outcome('failed', 'The browser reported an error showing the test notification. Check the system\'s notification settings and that a notification service is running.');
}
