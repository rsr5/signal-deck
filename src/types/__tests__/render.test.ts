import { describe, it, expect } from 'vitest';
import type {
  RenderSpec,
  TextSpec,
  ErrorSpec,
  TableSpec,
  HostCallSpec,
  HelpSpec,
  EntityCardSpec,
  KeyValueSpec,
  BadgeSpec,
  CopyableSpec,
  SummarySpec,
  HStackSpec,
} from '../index.js';

describe('RenderSpec types', () => {
  it('should accept a text spec', () => {
    const spec: RenderSpec = { type: 'text', content: 'hello' };
    expect(spec.type).toBe('text');
    expect((spec as TextSpec).content).toBe('hello');
  });

  it('should accept an error spec', () => {
    const spec: RenderSpec = { type: 'error', message: 'bad' };
    expect(spec.type).toBe('error');
    expect((spec as ErrorSpec).message).toBe('bad');
  });

  it('should accept a table spec', () => {
    const spec: RenderSpec = {
      type: 'table',
      headers: ['entity_id', 'state'],
      rows: [['sensor.temp', '22.5']],
    };
    expect(spec.type).toBe('table');
    expect((spec as TableSpec).rows).toHaveLength(1);
  });

  it('should accept a host call spec', () => {
    const spec: RenderSpec = {
      type: 'host_call',
      call_id: 'c1',
      method: 'get_states',
      params: { domain: 'sensor' },
    };
    expect(spec.type).toBe('host_call');
    expect((spec as HostCallSpec).method).toBe('get_states');
  });

  it('should accept a help spec', () => {
    const spec: RenderSpec = { type: 'help', content: 'help text' };
    expect(spec.type).toBe('help');
    expect((spec as HelpSpec).content).toContain('help');
  });

  it('should accept an entity card spec', () => {
    const spec: RenderSpec = {
      type: 'entity_card',
      entity_id: 'sensor.temp',
      icon: '󰔏',
      name: 'Temperature',
      state: '22.5',
      state_color: 'accent',
      unit: '°C',
      domain: 'sensor',
      device_class: 'temperature',
      last_changed: '10:30:00',
      attributes: [
        ['unit_of_measurement', '°C'],
        ['device_class', 'temperature'],
      ],
    };
    expect(spec.type).toBe('entity_card');
    expect((spec as EntityCardSpec).state).toBe('22.5');
    expect((spec as EntityCardSpec).attributes).toHaveLength(2);
  });

  it('should accept a key-value spec', () => {
    const spec: RenderSpec = {
      type: 'key_value',
      title: 'Attributes',
      pairs: [
        ['unit', '°C'],
        ['class', 'temperature'],
      ],
    };
    expect(spec.type).toBe('key_value');
    expect((spec as KeyValueSpec).pairs).toHaveLength(2);
  });

  it('should accept a badge spec', () => {
    const spec: RenderSpec = { type: 'badge', label: 'on', color: 'success' };
    expect(spec.type).toBe('badge');
    expect((spec as BadgeSpec).color).toBe('success');
  });

  it('should accept a copyable spec', () => {
    const spec: RenderSpec = {
      type: 'copyable',
      content: '{"state": "on"}',
      label: 'JSON',
    };
    expect(spec.type).toBe('copyable');
    expect((spec as CopyableSpec).content).toContain('state');
  });

  it('should accept a summary spec', () => {
    const spec: RenderSpec = { type: 'summary', content: '42 entities' };
    expect(spec.type).toBe('summary');
    expect((spec as SummarySpec).content).toContain('42');
  });

  it('should accept an hstack spec', () => {
    const spec: RenderSpec = {
      type: 'hstack',
      children: [
        { type: 'badge', label: 'on', color: 'success' },
        { type: 'text', content: 'hello' },
      ],
    };
    expect(spec.type).toBe('hstack');
    expect((spec as HStackSpec).children).toHaveLength(2);
  });
});
