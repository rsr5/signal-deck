import { describe, it, expect } from 'vitest';
import { fulfillHostCall, isHostCall } from '../host-functions.js';
import type { HomeAssistant, HassEntity } from '../../types/index.js';

/** Create a minimal mock hass object. */
function mockHass(states: Record<string, Partial<HassEntity>>): HomeAssistant {
  const fullStates: Record<string, HassEntity> = {};
  for (const [id, partial] of Object.entries(states)) {
    fullStates[id] = {
      entity_id: id,
      state: 'unknown',
      attributes: {},
      last_changed: '2026-02-15T10:00:00Z',
      last_updated: '2026-02-15T10:00:00Z',
      context: { id: '1', parent_id: null, user_id: null },
      ...partial,
    };
  }
  return {
    states: fullStates,
    callWS: async () => ({}),
    callApi: async () => ({}),
    callService: async () => {},
    language: 'en',
    locale: {},
  } as unknown as HomeAssistant;
}

describe('fulfillHostCall', () => {
  it('should return all states for get_states without domain', async () => {
    const hass = mockHass({
      'sensor.temp': { state: '22.5' },
      'binary_sensor.door': { state: 'off' },
    });
    const result = await fulfillHostCall(hass, 'get_states', {});
    const data = JSON.parse(result.data);
    expect(data).toHaveLength(2);
  });

  it('should filter states by domain', async () => {
    const hass = mockHass({
      'sensor.temp': { state: '22.5' },
      'binary_sensor.door': { state: 'off' },
    });
    const result = await fulfillHostCall(hass, 'get_states', { domain: 'sensor' });
    const data = JSON.parse(result.data);
    expect(data).toHaveLength(1);
    expect(data[0].entity_id).toBe('sensor.temp');
  });

  it('should return a single state for get_state', async () => {
    const hass = mockHass({
      'sensor.temp': { state: '22.5', attributes: { unit_of_measurement: '°C' } },
    });
    const result = await fulfillHostCall(hass, 'get_state', { entity_id: 'sensor.temp' });
    const data = JSON.parse(result.data);
    expect(data.entity_id).toBe('sensor.temp');
    expect(data.state).toBe('22.5');
  });

  it('should return error for missing entity', async () => {
    const hass = mockHass({});
    const result = await fulfillHostCall(hass, 'get_state', { entity_id: 'sensor.missing' });
    const data = JSON.parse(result.data);
    expect(data.error).toContain('not found');
  });

  it('should find entities by glob pattern', async () => {
    const hass = mockHass({
      'binary_sensor.lr_occupied': { state: 'on' },
      'binary_sensor.br_occupied': { state: 'off' },
      'sensor.temp': { state: '22.5' },
    });
    const result = await fulfillHostCall(hass, 'find_entities', { pattern: '*occupied*' });
    const data = JSON.parse(result.data);
    expect(data).toHaveLength(2);
  });

  it('should return error for unknown method', async () => {
    const hass = mockHass({});
    const result = await fulfillHostCall(hass, 'unknown_method', {});
    const data = JSON.parse(result.data);
    expect(data.error).toContain('Unknown');
  });
});

describe('isHostCall', () => {
  it('should return true for host_call spec', () => {
    expect(isHostCall({ type: 'host_call', call_id: '1', method: 'x', params: {} })).toBe(true);
  });

  it('should return false for text spec', () => {
    expect(isHostCall({ type: 'text', content: 'hello' })).toBe(false);
  });
});
