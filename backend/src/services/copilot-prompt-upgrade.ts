import { correctCopilotPrompt } from '../../../shared/src/prompts.js';
import { db, Prisma } from '../core/db.js';

export async function upgradeCopilotPrompts(apply = false) {
  const active = await db().promptTemplate.findMany({ where: { task: 'COPILOT', isActive: true }, orderBy: { workspaceId: 'asc' } });
  const results = [];
  for (const prompt of active) {
    const corrected = correctCopilotPrompt(prompt);
    if (corrected === prompt) continue;

    const result = { workspaceId: prompt.workspaceId, previousVersion: prompt.version, previousId: prompt.id };
    if (!apply) {
      results.push({ ...result, status: 'affected' });
      continue;
    }

    const updated = await db().$transaction(async tx => {
      const where = { workspaceId: prompt.workspaceId, task: 'COPILOT' as const };
      const latest = await tx.promptTemplate.findFirst({ where, orderBy: { version: 'desc' } });
      // Leave workspaces with a newer version or concurrently changed prompt for explicit review.
      if (latest?.id !== prompt.id) return null;
      const retired = await tx.promptTemplate.updateMany({
        where: { ...where, id: prompt.id, isActive: true, systemPrompt: prompt.systemPrompt, userPromptTemplate: prompt.userPromptTemplate },
        data: { isActive: false },
      });
      if (retired.count !== 1) return null;
      return tx.promptTemplate.create({
        data: {
          ...where,
          version: latest.version + 1,
          systemPrompt: corrected.systemPrompt,
          userPromptTemplate: corrected.userPromptTemplate,
          isActive: true,
          changeNote: `Correct authenticated Copilot request boundary (from v${prompt.version})`,
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    results.push(updated
      ? { ...result, status: 'updated', version: updated.version, id: updated.id }
      : { ...result, status: 'skipped_newer_or_changed' });
  }
  return results;
}
