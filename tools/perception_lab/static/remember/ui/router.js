// Hash router: #/now, #/people, #/people/:id, #/things, #/things/:id, #/moments, #/reminders.
export const ROUTES = [
  { key: 'now', label: 'Now' },
  { key: 'people', label: 'People' },
  { key: 'things', label: 'Things' },
  { key: 'moments', label: 'Moments' },
  { key: 'reminders', label: 'Reminders' },
];

export function parseHash(hash = location.hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const page = ROUTES.some((r) => r.key === parts[0]) ? parts[0] : 'now';
  return { page, id: parts[1] ? decodeURIComponent(parts[1]) : null };
}

export function navigate(page, id) {
  location.hash = `#/${page}${id ? `/${encodeURIComponent(id)}` : ''}`;
}

export function onRoute(fn) {
  window.addEventListener('hashchange', () => fn(parseHash()));
  return parseHash();
}
