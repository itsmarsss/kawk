// People list presentation: ordering, counts and per-person control labels. Pure functions so the
// ordering rule (enrolled first, then most recently seen; never-seen last) is unit-testable.
import type { Person } from './api.ts';

/** Enrolled people first, then most recently seen; people with no lastSeenAt (e.g. a just-enrolled gallery entry) sort last within their group. Stable on name/id. */
export function sortPeople(people: readonly Person[]): Person[] {
  return people.slice().sort((a, b) => {
    if (a.enrolled !== b.enrolled) return a.enrolled ? -1 : 1;
    const as = a.lastSeenAt ?? Number.NEGATIVE_INFINITY, bs = b.lastSeenAt ?? Number.NEGATIVE_INFINITY;
    if (as !== bs) return bs - as;
    return (a.name || '').localeCompare(b.name || '') || a.id.localeCompare(b.id);
  });
}

export interface PeopleCounts { total: number; enrolled: number; provisional: number }
export function countPeople(people: readonly Person[]): PeopleCounts {
  const enrolled = people.filter((p) => p.enrolled).length;
  return { total: people.length, enrolled, provisional: people.length - enrolled };
}

const shortId = (id: string, n = 8): string => (id.length > n ? id.slice(-n) : id);
/** Accessible name for a person's Delete control; includes the id suffix so two people sharing a name stay distinguishable. */
export function deleteButtonLabel(p: Person): string {
  return `Delete ${p.name || 'unnamed person'} (${p.enrolled ? 'enrolled' : 'provisional'}, id ${shortId(p.id)})`;
}
export function confirmDeleteButtonLabel(p: Person): string {
  return `Confirm delete ${p.name || 'unnamed person'} (${p.enrolled ? 'enrolled' : 'provisional'}, id ${shortId(p.id)})`;
}
