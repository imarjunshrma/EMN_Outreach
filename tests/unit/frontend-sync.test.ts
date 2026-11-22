import { describe, expect, it } from 'vitest';
import * as shared from '../../shared/src/workflow.js';
// eslint-disable-next-line no-restricted-imports -- deliberate: this test guards the copy of the vocabulary in the frontend
import * as ui from '../../frontend/lib/workflow.js';

// The builder UI keeps its own copy of the workflow vocabulary (the frontend bundle does not import shared/).
describe('frontend ↔ shared workflow vocabulary', () => {
  it('matches exactly', () => {
    expect([...ui.WORKFLOW_TRIGGERS]).toEqual([...shared.WORKFLOW_TRIGGERS]);
    expect([...ui.CONDITION_FIELDS]).toEqual([...shared.CONDITION_FIELDS]);
    expect([...ui.OPS]).toEqual([...shared.OPS]);
    expect([...ui.ACTIONS]).toEqual([...shared.ACTIONS]);
    expect(Object.keys(ui.ACTION_PARAMS).sort()).toEqual([...shared.ACTIONS].sort());
  });
  it('a graph built with the UI vocabulary validates on the server', () => {
    const g = { blocks: [{ id: 'c', kind: 'condition', all: [{ field: ui.CONDITION_FIELDS[0], op: 'in', value: ['US'] }], then: [{ id: 'a', kind: 'action', action: ui.ACTIONS[0], params: { tag: 'x' } }], else: [] }] };
    expect(shared.GraphSchema.safeParse(g).success).toBe(true);
  });
});

import * as aiShared from '../../shared/src/ai-workflows.js';
// eslint-disable-next-line no-restricted-imports -- deliberate: guards the UI copy of the AI workflow vocabulary
import * as aiUi from '../../frontend/lib/ai-workflows.js';

describe('frontend ↔ shared AI workflow vocabulary', () => {
  it('matches exactly', () => {
    expect([...aiUi.STAGE_PROVIDERS]).toEqual([...aiShared.STAGE_PROVIDERS]);
    expect([...aiUi.TASK_TYPES]).toEqual([...aiShared.TASK_TYPES]);
    expect([...aiUi.OUTPUT_FORMATS]).toEqual([...aiShared.OUTPUT_FORMATS]);
    expect([...aiUi.CONDITIONS]).toEqual([...aiShared.CONDITIONS]);
    expect(aiUi.TASK_LABELS).toEqual(aiShared.TASK_LABELS);
    expect(aiUi.PROVIDER_LABELS).toEqual(aiShared.PROVIDER_LABELS);
    expect(aiUi.DEFAULT_OUTPUT_FORMAT).toEqual(aiShared.DEFAULT_OUTPUT_FORMAT);
    expect(aiUi.WEB_TASKS).toEqual(aiShared.WEB_TASKS);
    expect(aiUi.INPUT_SOURCE_LABELS).toEqual(aiShared.INPUT_SOURCE_LABELS);
  });
  it('a stage built by the UI validates on the server for every task type', () => {
    for (const t of aiUi.TASK_TYPES) expect(aiShared.StageSchema.safeParse(aiUi.newStage(t)).success, t).toBe(true);
  });
});
