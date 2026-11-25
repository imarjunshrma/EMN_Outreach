import { disconnectDb } from '../backend/src/core/db.js';
import { upgradeCopilotPrompts } from '../backend/src/services/copilot-prompt-upgrade.js';

try {
  console.log(JSON.stringify(await upgradeCopilotPrompts(process.argv.includes('--apply')), null, 2));
} finally {
  await disconnectDb();
}
