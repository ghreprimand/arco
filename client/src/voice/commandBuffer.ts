import { VOICE_MAX_TEXT } from '@archon/shared';
import { immediateVoiceControl, voiceCommandBody } from './commands';

export const VOICE_CAPTURE_IDLE_MS = 120_000;
export type BufferedVoiceInput =
  | { kind: 'ignore' | 'cancel' | 'empty' | 'expired' | 'overflow' | 'quiet' | 'disable' }
  | { kind: 'pending' | 'execute'; text: string; started: boolean };

// The general recognizer renders a spoken "End capture" at the end of a
// run of speech as "I'm capture", "Am capture", "Good capture", "And
// capture" and similar (operator report, 2026-10-16). "capture" as the final
// word of a directive is reserved, so a known confusion of the first word
// closes the capture; an unrelated final word ("screen capture") does not.
export const END_WORDS = "end|ends|ended|ending|and|an|am|i['’]?m|im|in|en|n|then|than|hand|ten|good|ed|aunt|ant";
export const CANCEL_WORDS = 'cancel|cancels|cancelled|canceled|council|counsel|consul|cancer|can sell';
export const CLOSING_PHRASE = new RegExp(`(?:^|\\s)(${END_WORDS}|${CANCEL_WORDS})[\\s,:;.!?]+capt(?:ure|ured|cha|ur)[\\s,:;.!?]*$`, 'i');
export const isCancelWord = (word: string): boolean => new RegExp(`^(?:${CANCEL_WORDS})$`, 'i').test(word);
// Single-word closings (operator request, 2026-10-16: "End capture" is too
// cumbersome in natural speech). They count only when the whole recognized
// phrase is that word — i.e. the operator paused, then said it — so "move it
// over" or "over there" inside a directive stay literal. Radio-style "over"
// is the primary; the Trek ones are alternates.
export const STANDALONE_SUBMIT = /^(?:over|execute|engage|make it so)$/i;
export const STANDALONE_CANCEL = /^(?:cancel|belay that|never mind)$/i;
// "stop" / "quiet" alone close a capture that is still EMPTY (2026-10-17):
// "Computer" interrupts a reading and the next word is usually one of these.
// Once the capture holds any words they are literal, so "tell the director
// to … stop … the tests, over" is not cancelled by its own pause.
export const STANDALONE_STOP = /^(?:stop|quiet|be quiet|stop talking)$/i;
// Trailing form (2026-10-17): the operator rarely pauses before "over", so a
// phrase ENDING in "over" also closes ("open the plan, over"). Only the radio
// word gets this: "execute" / "cancel" end ordinary sentences ("explain
// execute", "tell it to cancel") and stay standalone-only. Trade-off accepted
// knowingly: a directive whose final word is literally "over" submits there.
const TRAILING_SUBMIT = /[\s,:;.!?]+(over)[\s,:;.!?"'“”‘’]*$/i;
export const standaloneClosing = (segment: string, empty = false): 'submit' | 'cancel' | null => {
  const alone = segment.trim().replace(/^[\s,:;.!?"'“”‘’]+|[\s,:;.!?"'“”‘’]+$/g, '').replace(/\s+/g, ' ');
  return STANDALONE_SUBMIT.test(alone) ? 'submit' : STANDALONE_CANCEL.test(alone) || (empty && STANDALONE_STOP.test(alone)) ? 'cancel' : null;
};
export const trailingSubmit = (segment: string): string | null => {
  const m = segment.match(TRAILING_SUBMIT);
  return m ? segment.slice(0, m.index).trim() : null;
};

// Computer arms capture independently of the directive. Only the complete
// closing phrase submits; silence and expiration can never execute anything.
export class VoiceCommandBuffer {
  text: string | null = null;
  expiresAt: number | null = null;
  clear(): void { this.text = null; this.expiresAt = null; }

  expire(now = Date.now()): boolean {
    if (this.expiresAt !== null && now >= this.expiresAt) { this.clear(); return true; }
    return false;
  }

  accept(raw: string, now = Date.now()): BufferedVoiceInput {
    const expired = this.expire(now);
    const input = raw.trim();
    if (!input) return { kind: expired ? 'expired' : 'ignore' };
    const body = voiceCommandBody(input);
    if (body !== null) {
      const action = immediateVoiceControl(body);
      if (action === 'disable') { this.clear(); return { kind: 'disable' }; }
      if (action === 'quiet') return { kind: 'quiet' };
    }
    // Computer is a wake word only while idle. ASR may start a later segment
    // with the same word; it is ordinary captured text, not a fresh directive.
    const started = this.text === null && body !== null;
    // A standalone closing word is judged on this phrase alone, before it is
    // appended: "Computer, over" ends empty; a later lone "over" submits.
    const piece = started ? body! : input;
    const standalone = this.text !== null || started ? standaloneClosing(piece, started || this.text === '') : null;
    if (standalone) {
      const text = (started ? '' : this.text!).trim().replace(/[,;:.!?]+$/, '').trim();
      this.clear();
      if (standalone === 'cancel') return { kind: 'cancel' };
      return text ? { kind: 'execute', text, started } : { kind: 'empty' };
    }
    const trailing = this.text !== null || started ? trailingSubmit(piece) : null;
    if (trailing !== null) {
      const text = [started ? '' : this.text!, trailing].filter(Boolean).join(' ').trim().replace(/[,;:.!?]+$/, '').trim();
      this.clear();
      return text ? { kind: 'execute', text, started } : { kind: 'empty' };
    }
    if (started) this.text = body;
    else if (this.text !== null) this.text += (this.text ? ' ' : '') + input;
    else return { kind: expired ? 'expired' : 'ignore' };


    if (this.text!.length > VOICE_MAX_TEXT) { this.clear(); return { kind: 'overflow' }; }
    // Match the whole reserved phrase only at the end. It may span ASR
    // segments; ordinary uses of end/cancel/capture/execute don't terminate.
    const closing = this.text!.match(CLOSING_PHRASE);
    if (closing) {
      const text = this.text!.slice(0, closing.index).trim().replace(/[,;:.!?]+$/, '').trim();
      this.clear();
      if (isCancelWord(closing[1])) return { kind: 'cancel' };
      return text ? { kind: 'execute', text, started } : { kind: 'empty' };
    }
    this.expiresAt = now + VOICE_CAPTURE_IDLE_MS;
    return { kind: 'pending', text: this.text!, started };
  }
}
