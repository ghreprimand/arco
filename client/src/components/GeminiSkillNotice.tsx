export function GeminiSkillNotice({ content }: { content: string }) {
  const start = content.indexOf('You have access to skills');
  const blockStart = start >= 0 ? start : content.indexOf('<arco-skills>');
  const end = content.indexOf('</arco-skills>') + '</arco-skills>'.length;
  const skills = content.slice(blockStart, end);
  const count = (skills.match(/<skill\s/g) ?? []).length;
  return <div style={{ color: 'var(--color-fg-muted)', fontSize: '11px', whiteSpace: 'pre-wrap' }}>
    {content.slice(0, blockStart)}
    <details><summary style={{ cursor: 'pointer' }}>Skill list sent to Gemini ({count} {count === 1 ? 'skill' : 'skills'})</summary>{skills}</details>
    {content.slice(end)}
  </div>;
}
