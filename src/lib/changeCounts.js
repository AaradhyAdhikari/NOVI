// The counts beside a file on the commit card, split so + and − can each have their colour.
export function countParts({ added, removed, isNew }) {
  if (isNew) return [{ kind: 'plus', text: 'new' }];
  if (added == null) return [{ kind: 'muted', text: 'changed' }];
  return [...(added ? [{ kind: 'plus', text: `+${added}` }] : []), ...(removed ? [{ kind: 'minus', text: `−${removed}` }] : [])];
}

// A tap on a file in the phone pop-up opens Novi with ?changes=<card>&file=<name>: only a file of this card.
export function openFileFrom(search, changes) {
  const q = new URLSearchParams(search || '');
  const file = q.get('file');
  return q.get('changes') === changes.id && changes.files.some((f) => f.file === file) ? file : null;
}
