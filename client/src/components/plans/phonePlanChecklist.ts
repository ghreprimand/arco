// docs/CLIENT.md "Mobile view" - a plan read as a checklist on a phone.
// The body is split into the text before the first phase, then one section
// per `###` phase with its checkbox items. Line numbers are the body's, so a
// tick flips the same line the workbench's PLAN tab would.

import { CHECKBOX_RE } from '../PlanBodyRenderer';

export interface PhonePlanItem { lineIndex: number; checked: boolean; text: string; depth: number; notes: string[] }
export interface PhonePlanPhase { heading: string; items: PhonePlanItem[]; notes: string[] }
export interface PhonePlanChecklist { intro: string[]; phases: PhonePlanPhase[]; done: number; total: number }

export function phonePlanChecklist(body: string): PhonePlanChecklist {
  const intro: string[] = [];
  const phases: PhonePlanPhase[] = [];
  let current: PhonePlanPhase | null = null;
  let item: PhonePlanItem | null = null;
  let done = 0, total = 0;
  body.split('\n').forEach((line, lineIndex) => {
    const heading = /^#{1,3}\s+(.*)$/.exec(line);
    if (heading && /^###\s/.test(line)) {
      current = { heading: heading[1].trim(), items: [], notes: [] };
      phases.push(current);
      item = null;
      return;
    }
    const box = CHECKBOX_RE.exec(line);
    if (box) {
      const checked = box[2].toLowerCase() === 'x';
      if (!current) { current = { heading: '', items: [], notes: [] }; phases.push(current); }
      item = { lineIndex, checked, text: box[3].trim(), depth: Math.floor(box[1].replace(/\t/g, '  ').length / 2), notes: [] };
      current.items.push(item);
      total += 1;
      if (checked) done += 1;
      return;
    }
    // A higher heading ends the phase; its text is read with the intro.
    if (heading) { item = null; current = null; intro.push(line); return; }
    if (!line.trim()) return;
    // An indented line under an item belongs to it; other lines to the phase.
    if (item && /^\s+\S/.test(line)) (item as PhonePlanItem).notes.push(line.trim().replace(/^[-*]\s+/, ''));
    else if (current) (current as PhonePlanPhase).notes.push(line.trim());
    else intro.push(line);
  });
  return { intro, phases, done, total };
}
