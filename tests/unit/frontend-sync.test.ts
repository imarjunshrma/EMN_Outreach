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
