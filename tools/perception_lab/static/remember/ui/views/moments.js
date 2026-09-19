// Moments: every saved / recording / failed clip, newest first.
import { h } from '../dom.js';
import { select } from '../../store/store.js';
import { momentTile, emptyState } from '../components.js';

export function renderMoments(ctx) {
  const { state, nowMs, actions } = ctx;
  const moments = select.moments(state);
  return h('div',
    h('div.page-head', h('div', h('h1', 'Moments'), h('p', ctx.mode === 'live' ? 'Clips from the temporary session buffer: 5 s before and after the marked instant, as far as the buffer had footage. They expire with the session.' : 'Ten-second clips around moments the provider marked as significant: 5 s before, the event, 5 s after.'))),
    moments.length ? h('div.moment-grid', ...moments.map((m) => momentTile(m, nowMs, actions.openMoment, state.profiles, actions.moment?.remove)))
      : emptyState('No moments yet', ctx.mode === 'live' ? 'Press “Mark moment” on Now while capture runs to save 5 s before and after from the real camera buffer.' : 'Run “Significant moment” or “Keys on the desk” from Now.', h('a.btn', { href: '#/now' }, 'Go to Now')));
}
