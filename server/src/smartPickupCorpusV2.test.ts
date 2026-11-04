import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

interface Case {
  id: string;
  split: string;
  recipient: { role: string };
  openTasks: { id: string; title: string }[];
  pendingMessages: { senderId: string; senderRole: string; body: string }[];
  recipientLastMessageToSender: Record<string, string>;
}

const corpus = JSON.parse(readFileSync(new URL('../../scripts/smoke/fixtures/smart-auto-pickup-corpus-v2.json', import.meta.url), 'utf8')) as { cases: Case[] };

function textFor(c: Case): string[] {
  return [
    ...c.pendingMessages.map((message) => message.body),
    ...Object.values(c.recipientLastMessageToSender),
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSentence(value: string, cases: Case[]): string {
  let sentence = value.toLocaleLowerCase('en-US');
  const specificValues = [...new Set(cases.flatMap((c) => [
    c.id,
    ...c.openTasks.flatMap((task) => [task.id, task.title]),
    ...c.pendingMessages.map((message) => message.senderId),
  ]))].sort((a, b) => b.length - a.length);
  for (const item of specificValues) {
    sentence = sentence.replace(new RegExp(escapeRegExp(item.toLocaleLowerCase('en-US')), 'g'), '<item>');
  }
  const roles = [...new Set(cases.flatMap((c) => [c.recipient.role, ...c.pendingMessages.map((message) => message.senderRole)]))]
    .sort((a, b) => b.length - a.length);
  for (const role of roles) {
    sentence = sentence.replace(new RegExp(`\\b${escapeRegExp(role.toLocaleLowerCase('en-US'))}\\b`, 'g'), '<role>');
  }
  return sentence.replace(/\s+/g, ' ').trim();
}

function sentences(value: string): string[] {
  return value.split(/[.!?]+/).map((sentence) => sentence.trim()).filter(Boolean);
}

test('held-out mail and thread text do not leak train strings or sentence templates', () => {
  const train = corpus.cases.filter((c) => c.split === 'train');
  const heldOut = corpus.cases.filter((c) => c.split === 'held_out');
  assert.equal(train.length, 100);
  assert.equal(heldOut.length, 50);

  const trainText = train.flatMap(textFor);
  const exact = new Set(trainText.map((value) => value.trim().toLocaleLowerCase('en-US')));
  for (const c of heldOut) {
    for (const value of textFor(c)) {
      assert.equal(exact.has(value.trim().toLocaleLowerCase('en-US')), false, `${c.id} repeats a train mail or thread string`);
    }
  }

  const trainSentences = new Set(trainText.flatMap(sentences).map((value) => normalizeSentence(value, corpus.cases)));
  for (const c of heldOut) {
    for (const value of textFor(c)) {
      for (const sentence of sentences(value)) {
        const normalized = normalizeSentence(sentence, corpus.cases);
        assert.equal(trainSentences.has(normalized), false, `${c.id} repeats a normalized train sentence: ${normalized}`);
      }
    }
  }
});
