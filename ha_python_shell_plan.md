
# Home Assistant Python Shell Card – Phased Implementation Plan

Author: Robin Ridler

Purpose: Build a Home Assistant Lovelace card that embeds a safe Python-like REPL
(via Monty or Pyodide WASM) for debugging, observability, and lightweight control.

---

## 1. Vision

A Lovelace custom card that provides:

• Safe Python shell in dashboard  
• Explore Home Assistant state directly  
• Copy‑paste snippets for LMM‑assisted debugging  
• Rich display output (entities, tables, ECharts graphs)  
• Optional mini‑automation widgets  
• Event‑driven and scheduled snippets  

Not a full automation engine. Not remote code execution.  
A debugging + observability instrument.

Inspired by:
• Jupyter notebooks  
• ipywidgets  
• HA Dev Tools  
• Robin’s ECharts dashboards  
• “Scores before booleans” observability philosophy  

---

## 2. Design Principles

1. Safe by default  
2. Small API surface  
3. LLM‑friendly output  
4. Observable behaviour  
5. Declarative configuration  
6. Runs entirely in Lovelace  

---

## 3. Architecture Overview

Browser card:
• Monty or Pyodide WASM runtime  
• HA WebSocket connection  
• Renderer for display specs  
• Widget engine  
• Scheduler + event watchers  

Python environment:
• ha.* API wrapper  
• ui.* display helpers  
• Magic command preprocessor  

No backend required.

---

## 4. Minimal Core API

### State
ha.state(entity_id)  
ha.get(entity_ids)  
ha.value(entity_id)  
ha.attr(entity_id, key)

### Enumeration
ha.entities(domain=None)  
ha.states(domain=None)  
ha.match(pattern, domain=None)

### History / Statistics
ha.history(entity_ids, start, end=None)  
ha.statistics(entity_ids, start, end=None)  
ha.ago("6h")

### Services (gated)
ha.arm(seconds=30)  
ha.call(domain, service, data)

---

## 5. Display System

ui.entity(entity_id)  
ui.entities(list)  
ui.table(rows)  
ui.json(obj)  
ui.ts(entity_ids, window="6h")  
ui.echarts(option)  
ui.log(events)  
ui.diff(a, b)  
ui.notice(text)  
ui.vstack([...])  
ui.hstack([...])

Auto‑render rules:
entity → entity card  
list of dicts → table  
dict → json  

---

## 6. Magic Commands

%ls binary_sensor  
%get sensor.temp  
%find *occupied*  
%hist sensor.temp -h 6  
%bundle living_room_presence  
%fmt table  

Bundles defined in YAML.

---

## 7. Widgets / Mini Automations

Inspired by ipywidgets.

ui.select()  
ui.slider()  
ui.toggle()  
ui.button()  
ui.datetime()

Execution styles:
• Reactive rerun  
• Button‑triggered  
• Event‑triggered  

Service calls require arm().

---

## 8. Scheduling & Event Snippets

startup:
  run: "%bundle living_room_presence"

schedule:
  - every: 60s
    run: "%bundle infra_health"

watch_state:
  - entities: [binary_sensor.lr_occupied_composite]
    run: "%bundle living_room_presence"

watch_events:
  - event_type: state_changed
    filter: "entity_id.endswith('_likely_occupied')"
    run: "%bundle living_room_presence"

Slots store outputs.

---

## 9. Phased Implementation

### Phase 1 – MVP Shell
Card skeleton  
Monty/Pyodide  
ha.state / ha.states / ha.match  
Magic commands  

### Phase 2 – Rich Display
ui.entity  
ui.table  
Auto‑render  
Copy output  

### Phase 3 – History & ECharts
ha.history  
ha.statistics  
ui.ts  
Binary sensor lanes  

### Phase 4 – Events & Scheduling
startup scripts  
watch_state  
watch_events  
Slots  

### Phase 5 – Widgets
Widget spec  
Reactive rerun  
Arm + confirm service calls  

### Phase 6 – Debugging Toolkit
Bundles DSL  
Explain‑flip helper  
Correlation helper  
Trace recording  
Debug report export  

### Phase 7 – Packaging
Docs  
Examples  
Performance  
Lazy WASM loading  

---

## 10. Safety Model

Read‑only default  
No filesystem/network  
Service calls gated  
Runtime/output limits  
Allowlist imports  
Audit log  

---

## Appendix – Extended Ideas

• Entity tap‑to‑inspect  
• Live tail‑f state stream  
• Record/replay traces  
• Correlation analysis  
• Explain‑flip diagnostics  
• Notebook slots  
• Sandbox profiles  
• Service call preview  
• ha.q() query language  
• What‑if simulators  
• Interactive entity graph  
• Export ECharts → echarts‑raw‑card YAML  

---

## Appendix – Future Research

Monty maturity  
MicroPython alternative  
Optional backend addon  
Sharing debug sessions  
LLM agent integration  

---

End
