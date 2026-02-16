/**
 * Light entity card — brightness bar, color temp, RGB swatch.
 */

import { html, nothing, type TemplateResult } from 'lit';
import type { EntityCardSpec } from '../../types/index.js';
import {
  renderCardHeader,
  renderCardMeta,
  renderAttrsTable,
  renderBar,
  renderColorSwatch,
  renderBadge,
  attrNum,
  attrStr,
  attrsExcluding,
  parseNumericList,
} from './helpers.js';

/** Attributes we render in the specialised section — hide from the generic table. */
const HANDLED_ATTRS = [
  'brightness', 'color_temp', 'color_temp_kelvin', 'hs_color', 'rgb_color',
  'xy_color', 'color_mode', 'min_mireds', 'max_mireds',
  'min_color_temp_kelvin', 'max_color_temp_kelvin',
  'supported_color_modes', 'effect', 'effect_list',
];

export function renderLightCard(spec: EntityCardSpec): TemplateResult {
  const stateClass = `state-${spec.state_color}`;
  const isOn = spec.state === 'on';

  // Brightness: HA stores 0–255, display as percentage.
  const brightness = attrNum(spec, 'brightness');
  const brightnessPct = brightness !== undefined ? Math.round((brightness / 255) * 100) : undefined;

  // Color temp in Kelvin.
  const colorTempK = attrNum(spec, 'color_temp_kelvin');

  // RGB color swatch.
  const rgbStr = attrStr(spec, 'rgb_color');
  const rgb = rgbStr ? parseNumericList(rgbStr) : undefined;

  // Color mode.
  const colorMode = attrStr(spec, 'color_mode');

  // Active effect.
  const effect = attrStr(spec, 'effect');

  // Remaining attributes (not handled above).
  const remaining = attrsExcluding(spec, HANDLED_ATTRS);

  return html`
    <div class="entity-card">
      ${renderCardHeader(spec)}

      <div class="entity-card-state">
        <span class="entity-card-state-value ${stateClass}">
          ${isOn && brightnessPct !== undefined ? `${brightnessPct}%` : spec.state}
        </span>
        ${isOn && rgb && rgb.length === 3
          ? renderColorSwatch(rgb[0], rgb[1], rgb[2])
          : nothing}
      </div>

      ${isOn && brightnessPct !== undefined
        ? renderBar(brightnessPct, 100, 'var(--sd-warning)', '󰃟 Brightness')
        : nothing}

      <div class="entity-light-details">
        ${colorTempK !== undefined
          ? html`<span class="entity-light-temp">󰖨 ${colorTempK}K</span>`
          : nothing}
        ${colorMode ? renderBadge(colorMode, 'badge-light-mode') : nothing}
        ${effect && effect !== 'None' && effect !== 'none'
          ? renderBadge(`✦ ${effect}`, 'badge-light-effect')
          : nothing}
      </div>

      ${renderCardMeta(spec)}
      ${renderAttrsTable(remaining)}
    </div>
  `;
}
