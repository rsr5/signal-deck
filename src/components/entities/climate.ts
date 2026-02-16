/**
 * Climate entity card — current vs target temp, HVAC mode badge, humidity.
 */

import { html, nothing, type TemplateResult } from 'lit';
import type { EntityCardSpec } from '../../types/index.js';
import {
  renderCardHeader,
  renderCardMeta,
  renderAttrsTable,
  renderBadge,
  attrNum,
  attrStr,
  attrsExcluding,
} from './helpers.js';

const HANDLED_ATTRS = [
  'temperature', 'target_temp_high', 'target_temp_low',
  'current_temperature', 'current_humidity', 'humidity',
  'hvac_action', 'hvac_modes', 'preset_mode', 'preset_modes',
  'fan_mode', 'fan_modes', 'swing_mode', 'swing_modes',
  'min_temp', 'max_temp',
];

/** Map HVAC action → badge CSS class */
const HVAC_BADGE: Record<string, string> = {
  heating: 'badge-climate-heat',
  cooling: 'badge-climate-cool',
  idle: 'badge-climate-idle',
  drying: 'badge-climate-dry',
  fan: 'badge-climate-fan',
  off: 'badge-climate-off',
};

export function renderClimateCard(spec: EntityCardSpec): TemplateResult {
  const stateClass = `state-${spec.state_color}`;

  const currentTemp = attrNum(spec, 'current_temperature');
  const targetTemp = attrNum(spec, 'temperature');
  const targetHigh = attrNum(spec, 'target_temp_high');
  const targetLow = attrNum(spec, 'target_temp_low');
  const humidity = attrNum(spec, 'current_humidity') ?? attrNum(spec, 'humidity');
  const hvacAction = attrStr(spec, 'hvac_action');
  const presetMode = attrStr(spec, 'preset_mode');
  const fanMode = attrStr(spec, 'fan_mode');
  const unit = spec.unit ?? '°';

  const remaining = attrsExcluding(spec, HANDLED_ATTRS);

  return html`
    <div class="entity-card">
      ${renderCardHeader(spec)}

      <div class="entity-climate-temps">
        ${currentTemp !== undefined
          ? html`
            <div class="entity-climate-current">
              <span class="entity-climate-current-value">${currentTemp}</span>
              <span class="entity-climate-current-unit">${unit}</span>
              <span class="entity-climate-current-label">current</span>
            </div>
          `
          : html`
            <div class="entity-card-state">
              <span class="entity-card-state-value ${stateClass}">${spec.state}</span>
            </div>
          `}

        ${targetTemp !== undefined
          ? html`
            <div class="entity-climate-target">
              <span class="entity-climate-target-arrow">→</span>
              <span class="entity-climate-target-value">${targetTemp}${unit}</span>
            </div>
          `
          : nothing}

        ${targetHigh !== undefined && targetLow !== undefined
          ? html`
            <div class="entity-climate-target">
              <span class="entity-climate-target-arrow">→</span>
              <span class="entity-climate-target-value">${targetLow}–${targetHigh}${unit}</span>
            </div>
          `
          : nothing}
      </div>

      <div class="entity-climate-badges">
        ${renderBadge(spec.state, `badge-climate-mode ${stateClass}`)}
        ${hvacAction
          ? renderBadge(hvacAction, HVAC_BADGE[hvacAction] ?? 'badge-climate-idle')
          : nothing}
        ${presetMode && presetMode !== 'none'
          ? renderBadge(presetMode, 'badge-climate-preset')
          : nothing}
        ${fanMode && fanMode !== 'off'
          ? renderBadge(`󰈐 ${fanMode}`, 'badge-climate-fan')
          : nothing}
        ${humidity !== undefined
          ? renderBadge(`󰖌 ${humidity}%`, 'badge-climate-humidity')
          : nothing}
      </div>

      ${renderCardMeta(spec)}
      ${renderAttrsTable(remaining)}
    </div>
  `;
}
