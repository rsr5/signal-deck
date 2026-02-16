/**
 * Weather entity card — current conditions, temp, humidity, wind.
 */

import { html, nothing, type TemplateResult } from 'lit';
import type { EntityCardSpec } from '../../types/index.js';
import {
  renderCardHeader,
  renderCardMeta,
  renderAttrsTable,
  attrNum,
  attrStr,
  attrsExcluding,
} from './helpers.js';

const HANDLED_ATTRS = [
  'temperature', 'humidity', 'pressure', 'wind_speed', 'wind_bearing',
  'visibility', 'forecast', 'apparent_temperature', 'dew_point',
  'cloud_coverage', 'uv_index', 'precipitation_unit', 'pressure_unit',
  'temperature_unit', 'visibility_unit', 'wind_speed_unit',
];

/** Map weather condition to Nerd Font icon. */
const CONDITION_ICON: Record<string, string> = {
  'clear-night':     '󰖔',
  cloudy:            '󰖐',
  exceptional:       '⚠',
  fog:               '󰖑',
  hail:              '󰖒',
  lightning:         '󰖓',
  'lightning-rainy': '󰖓',
  partlycloudy:      '󰖕',
  pouring:           '󰖖',
  rainy:             '󰖗',
  snowy:             '󰖘',
  'snowy-rainy':     '󰙿',
  sunny:             '󰖨',
  windy:             '󰖝',
  'windy-variant':   '󰖝',
};

export function renderWeatherCard(spec: EntityCardSpec): TemplateResult {
  const temp = attrNum(spec, 'temperature');
  const humidity = attrNum(spec, 'humidity');
  const pressure = attrNum(spec, 'pressure');
  const windSpeed = attrNum(spec, 'wind_speed');
  const windBearing = attrNum(spec, 'wind_bearing');
  const visibility = attrNum(spec, 'visibility');
  const apparentTemp = attrNum(spec, 'apparent_temperature');
  const uvIndex = attrNum(spec, 'uv_index');

  const tempUnit = attrStr(spec, 'temperature_unit') ?? '°';
  const speedUnit = attrStr(spec, 'wind_speed_unit') ?? '';
  const pressureUnit = attrStr(spec, 'pressure_unit') ?? '';
  const visUnit = attrStr(spec, 'visibility_unit') ?? '';

  const conditionIcon = CONDITION_ICON[spec.state] ?? '󰖐';

  // Human-readable condition label.
  const conditionLabel = spec.state.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const remaining = attrsExcluding(spec, HANDLED_ATTRS);

  return html`
    <div class="entity-card">
      ${renderCardHeader(spec)}

      <div class="entity-weather-main">
        <span class="entity-weather-condition-icon">${conditionIcon}</span>
        <div class="entity-weather-temp-block">
          ${temp !== undefined
            ? html`<span class="entity-weather-temp">${temp}${tempUnit}</span>`
            : nothing}
          <span class="entity-weather-condition">${conditionLabel}</span>
        </div>
      </div>

      ${apparentTemp !== undefined
        ? html`<div class="entity-weather-feels">Feels like ${apparentTemp}${tempUnit}</div>`
        : nothing}

      <div class="entity-weather-grid">
        ${humidity !== undefined
          ? html`<div class="entity-weather-stat">
              <span class="entity-weather-stat-icon">󰖌</span>
              <span>${humidity}%</span>
            </div>`
          : nothing}
        ${windSpeed !== undefined
          ? html`<div class="entity-weather-stat">
              <span class="entity-weather-stat-icon">󰖝</span>
              <span>${windSpeed} ${speedUnit}</span>
              ${windBearing !== undefined
                ? html`<span class="entity-weather-wind-dir">${windDirection(windBearing)}</span>`
                : nothing}
            </div>`
          : nothing}
        ${pressure !== undefined
          ? html`<div class="entity-weather-stat">
              <span class="entity-weather-stat-icon">󰀝</span>
              <span>${pressure} ${pressureUnit}</span>
            </div>`
          : nothing}
        ${visibility !== undefined
          ? html`<div class="entity-weather-stat">
              <span class="entity-weather-stat-icon">󰈈</span>
              <span>${visibility} ${visUnit}</span>
            </div>`
          : nothing}
        ${uvIndex !== undefined
          ? html`<div class="entity-weather-stat">
              <span class="entity-weather-stat-icon">󰖨</span>
              <span>UV ${uvIndex}</span>
            </div>`
          : nothing}
      </div>

      ${renderCardMeta(spec)}
      ${renderAttrsTable(remaining)}
    </div>
  `;
}

/** Convert wind bearing degrees to a compass direction. */
function windDirection(bearing: number): string {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const idx = Math.round(bearing / 22.5) % 16;
  return dirs[idx];
}
