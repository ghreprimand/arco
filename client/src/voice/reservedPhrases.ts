import { editDistance, voiceCommandBody } from './commands';
import { CANCEL_WORDS, END_WORDS, STANDALONE_CANCEL, STANDALONE_SUBMIT } from './commandBuffer';

// The general recognizer often writes "and capture" (or "I'm / am / good
// capture") for spoken End capture. Repair only reserved boundaries confirmed
// by the separate acoustic grammar; ordinary dictation and every word inside
// an existing capture stay verbatim. Known first-word confusions also close
// the capture without grammar agreement (see CLOSING_PHRASE); this repair
// covers the remaining cases where the first word was lost or unrecognizable.
export function reservedVoiceText(raw: string, phrases: string, armed: boolean, wakeDetected = false): string {
  const recognized = phrases.trim().toLowerCase();
  let text = raw;
  if (!armed && recognized === 'computer' && !text.trim()) text = 'Computer';
  if (!armed && /^computer\b/.test(recognized)) text = text.replace(/^\s*(?:a|the) computer\b/i, 'Computer');
  if (!armed) text = repairWakeWord(text, wakeDetected || /^computer\b/.test(recognized));
  if (armed && !text.trim() && ['end capture', 'cancel capture'].includes(recognized)) return recognized;
  // A lone closing word: the grammar heard it and general transcription
  // produced nothing or a single different token ("Oval."), so use the word.
  if (armed && (STANDALONE_SUBMIT.test(recognized) || STANDALONE_CANCEL.test(recognized)) && !/\s/.test(text.trim().replace(/[,:;.!?]+$/, ''))) return recognized;

  if (armed || voiceCommandBody(text) !== null) {
    const confirmed = /(?:^| )(end|cancel) capture$/.exec(recognized)?.[1];
    if (confirmed) {
      const word = confirmed === 'end' ? 'End' : 'Cancel';
      const tail = '([\\s,:;.!?]+capt(?:ure|ured|cha|ur)[\\s,:;.!?]*)$';
      // "... for now and capture." → replace the misheard word; "... for now
      // capture." → the word was dropped entirely, so insert it.
      const misheard = new RegExp(`(^|\\s)(?:${END_WORDS}|${CANCEL_WORDS}|a|i|the|to|it|un)${tail}`, 'i');
      if (misheard.test(text)) text = text.replace(misheard, `$1${word}$2`);
      else text = text.replace(/(^|\s)(capt(?:ure|ured|cha|ur)[\s,:;.!?]*)$/i, `$1${word} $2`);
    }
  }
  return text;
}

// Wake-word tolerance (operator report, 2026-10-17: "I had to say computer
// three times"). The general recognizer renders a spoken Computer as
// "Computers", "Commuter", "Computed", "Compute her", "Come here" and
// similar; requiring the literal word threw the whole utterance away and
// made the operator repeat everything. A first token one edit from
// "computer" (plural/possessive s ignored) is the wake word on its own; two
// edits would admit real words such as "compiler". When the independent phrase
// grammar (fast wake or the per-segment phrase pass) also heard Computer
// first, a looser slip — including two fused tokens — is accepted: the
// grammar is the better judge of the wake word, the general recognizer of
// the words after it. A first word that resembles nothing still fails, and a
// preamble before a clear "Computer" ("Hey Computer") is never rewritten,
// because a speculative fast wake must not authorize an utterance whose
// first word was something else. Only the first word is ever touched, only
// while idle; a captured directive and ordinary dictation stay verbatim.
export function repairWakeWord(text: string, grammarHeardComputer: boolean): string {
  if (voiceCommandBody(text) !== null) return text;
  const m = /^(\s*)([a-z'’]+)(?:([\s,]+)([a-z'’]+))?/i.exec(text);
  if (!m || /^computer$/i.test(m[4] ?? '')) return text;
  // "Computers" / "Computer's" are the plural/possessive slips: drop the s.
  const norm = (s: string) => s.toLowerCase().replace(/['’]/g, '').replace(/s$/, '');
  const one = editDistance(norm(m[2]), 'computer');
  const two = m[4] ? editDistance(norm(m[2] + m[4]), 'computer') : Infinity;
  if (one <= (grammarHeardComputer ? 3 : 1) && one <= two) return `Computer${text.slice(m[1].length + m[2].length)}`;
  if (two <= (grammarHeardComputer ? 4 : 1)) return `Computer${text.slice(m[0].length)}`;
  return text;
}
