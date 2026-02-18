/**
 * Calendar entity card — shows next event + hint to use events().
 */

import { html, nothing, type TemplateResult } from 'lit';
import type { EntityCardSpec } from '../../types/index.js';
import {
  renderCardHeader,
  renderCardMeta,
  renderAttrsTable,
  attrStr,
  attrsExcluding,
} from './helpers.js';

const HANDLED_ATTRS = [
  'message', 'description', 'all_day', 'start_time', 'end_time', 'location',
];

export function renderCalendarCard(spec: EntityCardSpec): TemplateResult {
  const stateClass = `state-${spec.state_color}`;
  const message = attrStr(spec, 'message');
  const description = attrStr(spec, 'description');
  const startTime = attrStr(spec, 'start_time');
  const endTime = attrStr(spec, 'end_time');
  const allDay = attrStr(spec, 'all_day');
  const location = attrStr(spec, 'location');

  const remaining = attrsExcluding(spec, HANDLED_ATTRS);

  return html`
    <div class="entity-card">
      ${renderCardHeader(spec)}

      <div class="entity-card-state">
        <span class="entity-card-state-value ${stateClass}">${spec.state}</span>
      </div>

      ${message
        ? html`<div class="entity-calendar-event">
            <div class="entity-calendar-summary">📅 ${message}</div>
            ${description && description !== 'None' && description !== ''
              ? html`<div class="entity-calendar-desc">${description}</div>`
              : nothing}
            ${startTime
              ? html`<div class="entity-calendar-time">
                  ${allDay === 'True' ? '🗓 All day' : `🕐 ${startTime}`}${endTime && allDay !== 'True' ? ` → ${endTime}` : nothing}
                </div>`
              : nothing}
            ${location && location !== 'None' && location !== ''
              ? html`<div class="entity-calendar-location">📍 ${location}</div>`
              : nothing}
          </div>`
        : nothing}

      <div class="entity-calendar-hint">
        💡 <code>events("${spec.entity_id}")</code> — see all upcoming events
      </div>

      ${renderCardMeta(spec)}
      ${renderAttrsTable(remaining)}
    </div>
  `;
}
