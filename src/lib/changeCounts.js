// The counts beside a file on the commit card, split so + and − can each have their colour.
export function countParts({ added, removed, isNew }) {
  if (isNew) return [{ kind: 'plus', text: 'new' }];
  if (added == null) return [{ kind: 'muted', text: 'changed' }];
  return [...(added ? [{ kind: 'plus', text: `+${added}` }] : []), ...(removed ? [{ kind: 'minus', text: `−${removed}` }] : [])];
}
