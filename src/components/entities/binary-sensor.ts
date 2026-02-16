/**
 * Binary sensor entity card — clean on/off with device_class-aware labels.
 */

import { html, type TemplateResult } from 'lit';
import type { EntityCardSpec } from '../../types/index.js';
import { renderCardHeader, renderCardMeta, renderAttrsTable, renderBadge, attrsExcluding } from './helpers.js';

/** Map device_class → [on_label, off_label] */
const LABELS: Record<string, [string, string]> = {
  door:         ['Open', 'Closed'],
  window:       ['Open', 'Closed'],
  garage_door:  ['Open', 'Closed'],
  opening:      ['Open', 'Closed'],
  motion:       ['Motion', 'Clear'],
  occupancy:    ['Occupied', 'Clear'],
  presence:     ['Present', 'Away'],
  lock:         ['Unlocked', 'Locked'],
  moisture:     ['Wet', 'Dry'],
  smoke:        ['Detected', 'Clear'],
  gas:          ['Detected', 'Clear'],
  co:           ['Detected', 'Clear'],
  safety:       ['Unsafe', 'Safe'],
  problem:      ['Problem', 'OK'],
  battery:      ['Low', 'Normal'],
  connectivity: ['Connected', 'Disconnected'],
  plug:         ['Plugged in', 'Unplugged'],
  vibration:    ['Vibrating', 'Still'],
  sound:        ['Sound', 'Quiet'],
  light:        ['Light', 'Dark'],
  cold:         ['Cold', 'Normal'],
  heat:         ['Hot', 'Normal'],
  power:        ['On', 'Off'],
  running:      ['Running', 'Stopped'],
  moving:       ['Moving', 'Stopped'],
  tamper:       ['Tampered', 'OK'],
  update:       ['Available', 'Up to date'],
};

const HANDLED_ATTRS = ['device_class'];

export function renderBinarySensorCard(spec: EntityCardSpec): TemplateResult {
  const isOn = spec.state === 'on';
  const dc = spec.device_class ?? '';
  const labels = LABELS[dc] ?? ['On', 'Off'];
  const label = isOn ? labels[0] : labels[1];

  const stateClass = `state-${spec.state_color}`;
  const indicator = isOn ? '●' : '○';

  const remaining = attrsExcluding(spec, HANDLED_ATTRS);

  return html`
    <div class="entity-card">
      ${renderCardHeader(spec)}

      <div class="entity-binary-state">
        <span class="entity-binary-indicator ${stateClass}">${indicator}</span>
        <span class="entity-binary-label ${stateClass}">${label}</span>
        ${dc ? renderBadge(dc, 'badge-binary-dc') : ''}
      </div>

      ${renderCardMeta(spec)}
      ${renderAttrsTable(remaining)}
    </div>
  `;
}
