/**
 * Shared helper functions for entity card renderers.
 *
 * Small utilities for extracting attributes, rendering bars, badges, etc.
 */

import { html, nothing, type TemplateResult } from 'lit';
import type { EntityCardSpec } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Attribute extraction
// ---------------------------------------------------------------------------

/** Get a numeric attribute value, or undefined. */
export function attrNum(spec: EntityCardSpec, key: string): number | undefined {
  const pair = spec.attributes.find(([k]) => k === key);
  if (!pair) return undefined;
  const n = Number(pair[1]);
  return isNaN(n) ? undefined : n;
}

/** Get a string attribute value, or undefined. */
export function attrStr(spec: EntityCardSpec, key: string): string | undefined {
  const pair = spec.attributes.find(([k]) => k === key);
  return pair?.[1];
}

/** Get attributes filtered to exclude a set of keys. */
export function attrsExcluding(spec: EntityCardSpec, exclude: string[]): [string, string][] {
  return spec.attributes.filter(([k]) => !exclude.includes(k));
}

// ---------------------------------------------------------------------------
// Shared rendering fragments
// ---------------------------------------------------------------------------

/** Render the standard card header (icon + name + entity_id). */
export function renderCardHeader(spec: EntityCardSpec): TemplateResult {
  const stateClass = `state-${spec.state_color}`;
  return html`
    <div class="entity-card-header">
      <span class="entity-card-icon ${stateClass}">${spec.icon}</span>
      <div>
        <div class="entity-card-name">${spec.name}</div>
        <div class="entity-card-id">${spec.entity_id}</div>
      </div>
    </div>
  `;
}

/** Render the standard meta row (domain · device_class · last_changed). */
export function renderCardMeta(spec: EntityCardSpec): TemplateResult {
  return html`
    <div class="entity-card-meta">
      ${spec.domain ? html`<span>󰘦 ${spec.domain}</span>` : nothing}
      ${spec.device_class ? html`<span>◈ ${spec.device_class}</span>` : nothing}
      <span>◷ ${spec.last_changed}</span>
    </div>
  `;
}

/** Render a list of attribute key-value pairs as a table. */
export function renderAttrsTable(attrs: [string, string][]): TemplateResult {
  if (attrs.length === 0) return html``;
  return html`
    <div class="entity-card-attrs">
      <table class="kv-table">
        <tbody>
          ${attrs.map(
            ([key, value]) => html`
              <tr>
                <td class="kv-key">${key}</td>
                <td class="kv-value">${value}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

/** Render a horizontal progress/level bar. */
export function renderBar(
  value: number,
  max: number,
  color: string,
  label?: string,
): TemplateResult {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return html`
    <div class="entity-bar">
      ${label ? html`<span class="entity-bar-label">${label}</span>` : nothing}
      <div class="entity-bar-track">
        <div class="entity-bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div>
      </div>
      <span class="entity-bar-value">${Math.round(pct)}%</span>
    </div>
  `;
}

/** Render a small inline coloured badge pill. */
export function renderBadge(label: string, cssClass: string): TemplateResult {
  return html`<span class="entity-badge ${cssClass}">${label}</span>`;
}

/** Render a small color swatch circle. */
export function renderColorSwatch(r: number, g: number, b: number): TemplateResult {
  return html`<span
    class="entity-color-swatch"
    style="background:rgb(${r},${g},${b})"
    title="RGB(${r}, ${g}, ${b})"
  ></span>`;
}

/** Parse a JSON-ish attribute string like "[255, 180, 60]" into an array of numbers. */
export function parseNumericList(val: string): number[] | undefined {
  try {
    const arr = JSON.parse(val);
    if (Array.isArray(arr) && arr.every((n: unknown) => typeof n === 'number')) {
      return arr as number[];
    }
  } catch { /* ignore */ }
  return undefined;
}
