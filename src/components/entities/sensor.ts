/**
 * Sensor entity card — big number for numerics, battery bar, relative timestamps.
 */

import { html, nothing, type TemplateResult } from 'lit';
import type { EntityCardSpec } from '../../types/index.js';
import {
  renderCardHeader,
  renderCardMeta,
  renderAttrsTable,
  renderBar,
  attrsExcluding,
} from './helpers.js';

const HANDLED_ATTRS = ['state_class'];

export function renderSensorCard(spec: EntityCardSpec): TemplateResult {
  const stateClass = `state-${spec.state_color}`;
  const dc = spec.device_class ?? '';
  const isNumeric = spec.state !== '' && !isNaN(Number(spec.state));

  // Battery — show a level bar.
  const isBattery = dc === 'battery';
  const batteryLevel = isBattery && isNumeric ? Number(spec.state) : undefined;

  // Timestamp sensor — show relative time.
  const isTimestamp = dc === 'timestamp';

  const remaining = attrsExcluding(spec, HANDLED_ATTRS);

  return html`
    <div class="entity-card">
      ${renderCardHeader(spec)}

      <div class="entity-card-state">
        <span class="entity-card-state-value ${stateClass}">
          ${isTimestamp ? formatRelativeTime(spec.state) : spec.state}
        </span>
        ${spec.unit ? html`<span class="entity-card-state-unit">${spec.unit}</span>` : nothing}
      </div>

      ${batteryLevel !== undefined
        ? renderBar(batteryLevel, 100, batteryColor(batteryLevel), '󰁹 Battery')
        : nothing}

      ${renderCardMeta(spec)}
      ${renderAttrsTable(remaining)}
    </div>
  `;
}

/** Pick a bar color based on battery percentage. */
function batteryColor(level: number): string {
  if (level <= 15) return 'var(--sd-error)';
  if (level <= 40) return 'var(--sd-warning)';
  return 'var(--sd-success)';
}

/** Format an ISO timestamp as a relative "Xh ago" string. */
function formatRelativeTime(iso: string): string {
  try {
    const ts = new Date(iso).getTime();
    if (isNaN(ts)) return iso;
    const diffMs = Date.now() - ts;
    if (diffMs < 0) return iso; // future

    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return iso;
  }
}
