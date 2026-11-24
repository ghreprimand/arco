// Mobile view: the text size of this browser's phone view (100, 110 or 120
// percent), shown in Settings under THIS PHONE. The workbench's own scale is
// not changed (docs/CLIENT.md "Mobile view").

import { useState } from 'react';
import { MOBILE_TEXT_SIZES, readMobileTextSize, writeMobileTextSize } from '../themes/bootstrap';

export function MobileTextSize() {
  const [size, setSize] = useState(readMobileTextSize);
  return (
    <div data-testid="mobile-this-phone" style={{ padding: '14px 0 calc(16px + env(safe-area-inset-bottom))' }}>
      <div className="display-font" style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '1.5px', color: 'var(--color-fg)', padding: '0 14px 8px' }}>THIS PHONE</div>
      <div role="group" aria-label="Text size on this phone" data-help="mobile.text-size" style={{ display: 'flex', gap: '8px', padding: '0 14px', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '14px', marginRight: '4px', color: 'var(--color-fg)' }}>Text size</span>
        {MOBILE_TEXT_SIZES.map((s) => (
          <button key={s} type="button" aria-pressed={size === s} data-testid="mobile-text-size" className="display-font"
            style={{ minHeight: '44px', minWidth: '44px', width: 'auto', padding: '0 12px', fontSize: '12px', letterSpacing: '0.5px', cursor: 'pointer', background: 'transparent', borderRadius: '4px', textAlign: 'center',
              border: `1px solid ${size === s ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`, color: size === s ? 'var(--color-accent-primary)' : 'var(--color-fg)' }}
            onClick={() => { writeMobileTextSize(s); setSize(s); }}>{Math.round(s * 100)}%</button>
        ))}
      </div>
      <p style={{ fontSize: '13px', color: 'var(--color-fg)', padding: '12px 14px 0', margin: 0 }}>
        Colours follow the theme chosen in Settings, on the computer and here; the text brightness setting applies on the computer only.
      </p>
    </div>
  );
}
