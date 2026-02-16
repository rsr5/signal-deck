/**
 * Person entity card — location-centric display.
 */

import { html, nothing, type TemplateResult } from 'lit';
import type { EntityCardSpec } from '../../types/index.js';
import {
  renderCardHeader,
  renderCardMeta,
  renderAttrsTable,
  renderBadge,
  attrStr,
  attrsExcluding,
} from './helpers.js';

const HANDLED_ATTRS = [
  'source', 'latitude', 'longitude', 'gps_accuracy',
  'entity_picture', 'user_id', 'id', 'device_trackers',
];

export function renderPersonCard(spec: EntityCardSpec): TemplateResult {
  const stateClass = `state-${spec.state_color}`;
  const source = attrStr(spec, 'source');
  const lat = attrStr(spec, 'latitude');
  const lon = attrStr(spec, 'longitude');
  const gpsAcc = attrStr(spec, 'gps_accuracy');
  const trackers = attrStr(spec, 'device_trackers');

  // Person state is typically "home", "not_home", or a zone name.
  const locationLabel = spec.state === 'not_home'
    ? 'Away'
    : spec.state.charAt(0).toUpperCase() + spec.state.slice(1);

  const remaining = attrsExcluding(spec, HANDLED_ATTRS);

  return html`
    <div class="entity-card">
      ${renderCardHeader(spec)}

      <div class="entity-person-location">
        <span class="entity-person-location-icon ${stateClass}">
          ${spec.state === 'home' ? '󰋑' : '󰍒'}
        </span>
        <span class="entity-person-location-label ${stateClass}">${locationLabel}</span>
      </div>

      <div class="entity-person-details">
        ${source ? renderBadge(`󰍒 ${source}`, 'badge-person-source') : nothing}
        ${lat && lon
          ? html`<span class="entity-person-coords">📍 ${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)}</span>`
          : nothing}
        ${gpsAcc ? html`<span class="entity-person-gps">± ${gpsAcc}m</span>` : nothing}
      </div>

      ${trackers
        ? html`<div class="entity-person-trackers">
            <span class="entity-person-trackers-label">Trackers:</span>
            <span class="entity-person-trackers-value">${formatTrackers(trackers)}</span>
          </div>`
        : nothing}

      ${renderCardMeta(spec)}
      ${renderAttrsTable(remaining)}
    </div>
  `;
}

/** Format a JSON array of tracker entity_ids into a readable string. */
function formatTrackers(raw: string): string {
  try {
    const arr = JSON.parse(raw.replace(/'/g, '"'));
    if (Array.isArray(arr)) {
      return arr.map((id: string) => id.replace('device_tracker.', '')).join(', ');
    }
  } catch { /* ignore */ }
  return raw;
}
