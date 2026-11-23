// An email is never approved or sent when its body is a placeholder or has no message (the "Hi Test, … Best" incident).
import { it, expect } from 'vitest';
import { bodyContentProblem as p } from '../../shared/src/template.js';
it('flags placeholders, empty bodies and greeting-only emails, and accepts real short messages', () => {
  expect(p('Hi {{firstName|there}},\n\n…\n\nBest,\n{{sender.name}}')).toMatch(/placeholder/);
  expect(p('Hi {{firstName|there}},\n\n[Write your message here]\n\nBest,\n{{sender.name}}')).toMatch(/placeholder/);
  expect(p('Hi {{firstName}},\n\nBest,\nArjun')).toMatch(/no message/);
  expect(p('   ')).toMatch(/empty/);
  expect(p('Hi')).toMatch(/no message/);
  expect(p('Hi {{firstName}}, a question.')).toBeNull();
  expect(p('Bump')).toBeNull();
  expect(p('Following up, {{firstName}}.')).toBeNull();
  expect(p('Hi {{firstName}},\n\nQuick idea.\n\n{{sender.name}}')).toBeNull();
  expect(p('{{aiFirstLine}}\n\nQuick idea for you.')).toBeNull();
  expect(p('Hello Priya Sharma!\nSaw your new clinic... looks great.\nThanks,\nA')).toBeNull();
});
