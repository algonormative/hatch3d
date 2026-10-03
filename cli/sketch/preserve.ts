import type { Part, Pen, RenderResult } from '../../src/sketch/types.ts';

export interface PreserveSelection { parts: string[]; boundaries?: string[] }
export interface PreserveChange { scope: 'page' | 'part' | 'pen' | 'boundary'; id: string; message: string }
export interface PreserveComparison { ok: boolean; changes: PreserveChange[] }

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const samePen = (a: Pen, b: Pen): boolean => a.id === b.id && a.color === b.color && a.width === b.width && (a.passes ?? 1) === (b.passes ?? 1);
const partById = (result: RenderResult, id: string): Part | undefined => result.parts.find(part => part.id === id);
const penById = (result: RenderResult, id: string): Pen | undefined => result.metadata.pens.find(pen => pen.id === id);

/** Assert nominated final paths and their physical rendering settings; never repair. */
export function comparePreserved(before: RenderResult, after: RenderResult, selection: PreserveSelection): PreserveComparison {
  const changes: PreserveChange[] = [];
  const parts = [...new Set(selection.parts)];
  const boundaries = [...new Set(selection.boundaries ?? [])];
  if ((parts.length || boundaries.length) && !same(before.metadata.page, after.metadata.page)) {
    changes.push({ scope: 'page', id: 'page', message: 'Page dimensions, paper, or margin changed' });
  }
  for (const id of parts) {
    const oldPart = partById(before, id);
    const newPart = partById(after, id);
    if (!oldPart || !newPart) {
      changes.push({ scope: 'part', id, message: `Nominated part ${id} is missing` });
      continue;
    }
    if (oldPart.pen !== newPart.pen || !same(oldPart.paths, newPart.paths) || oldPart.diagnostic !== newPart.diagnostic) {
      changes.push({ scope: 'part', id, message: `Final visible paths or pen assignment changed for ${id}` });
    }
    const oldPen = penById(before, oldPart.pen);
    const newPen = penById(after, newPart.pen);
    if (!oldPen || !newPen || !samePen(oldPen, newPen)) {
      changes.push({ scope: 'pen', id, message: `Physical pen settings changed for ${id}` });
    }
  }
  for (const id of boundaries) {
    const oldBoundary = partById(before, id)?.boundary;
    const newBoundary = partById(after, id)?.boundary;
    if (!oldBoundary || !newBoundary || !same(oldBoundary, newBoundary)) {
      changes.push({ scope: 'boundary', id, message: `Nominated region boundary changed for ${id}` });
    }
  }
  return { ok: changes.length === 0, changes };
}
