/**
 * Cover entity card — position bar, tilt, open/closed state.
 */

import { html, nothing, type TemplateResult } from 'lit';
import type { EntityCardSpec } from '../../types/index.js';
import {
  renderCardHeader,
  renderCardMeta,
  renderAttrsTable,
  renderBar,
  renderBadge,
  attrNum,
  attrsExcluding,
} from './helpers.js';

const HANDLED_ATTRS = [
  'current_position', 'current_tilt_position',
];

export function renderCoverCard(spec: EntityCardSpec): TemplateResult {
  const stateClass = `state-${spec.state_color}`;
  const position = attrNum(spec, 'current_position');
  const tilt = attrNum(spec, 'current_tilt_position');

  // State label for covers.
  const stateLabel = spec.state.charAt(0).toUpperCase() + spec.state.slice(1);

  const remaining = attrsExcluding(spec, HANDLED_ATTRS);

  return html`
    <div class="entity-card">
      ${renderCardHeader(spec)}

      <div class="entity-card-state">
        <span class="entity-card-state-value ${stateClass}">${stateLabel}</span>
      </div>

      ${position !== undefined
        ? renderBar(position, 100, 'var(--sd-accent)', '󰦗 Position')
        : nothing}

      ${tilt !== undefined
        ? renderBar(tilt, 100, 'var(--sd-dim)', '󰍽 Tilt')
        : nothing}

      <div class="entity-cover-badges">
        ${spec.device_class
          ? renderBadge(spec.device_class, 'badge-cover-type')
          : nothing}
      </div>

      ${renderCardMeta(spec)}
      ${renderAttrsTable(remaining)}
    </div>
  `;
}
