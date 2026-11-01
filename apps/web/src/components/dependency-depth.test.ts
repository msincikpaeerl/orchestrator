import { describe, expect, it } from 'vitest';
import { dependencyLayers } from './dependency-depth';

const node = (id: string, ...waitsFor: string[]) => ({ id, waitsFor });

describe('dependency depth (lot 5 step H)', () => {
  it('puts a chain one ticket per column', () => {
    expect(dependencyLayers([node('C', 'B'), node('B', 'A'), node('A')])).toEqual({
      columns: [['A'], ['B'], ['C']],
      loop: [],
    });
  });

  it('puts a diamond in three columns, the last after its deepest blocker', () => {
    const layers = dependencyLayers([
      node('BOOT'),
      node('FORM', 'BOOT'),
      node('PAGE', 'BOOT'),
      node('DOCS', 'FORM', 'PAGE'),
    ]);
    expect(layers).toEqual({ columns: [['BOOT'], ['FORM', 'PAGE'], ['DOCS']], loop: [] });
  });

  it('uses the longest way to a ticket, not the shortest', () => {
    const layers = dependencyLayers([node('A'), node('B', 'A'), node('C', 'A', 'B')]);
    expect(layers.columns).toEqual([['A'], ['B'], ['C']]);
  });

  it('puts independent tickets in the first column, in the order given', () => {
    expect(dependencyLayers([node('X'), node('Y'), node('Z')])).toEqual({
      columns: [['X', 'Y', 'Z']],
      loop: [],
    });
  });

  it('ignores blockers that are not in the graph', () => {
    expect(dependencyLayers([node('A', 'WEB-1'), node('B', 'A', 'WEB-2')]).columns).toEqual([
      ['A'],
      ['B'],
    ]);
  });

  it('has no columns without tickets', () => {
    expect(dependencyLayers([])).toEqual({ columns: [], loop: [] });
  });

  it('puts a loop, and what waits for it, in its own list instead of hanging', () => {
    const layers = dependencyLayers([
      node('A'),
      node('B', 'A', 'D'),
      node('C', 'B'),
      node('D', 'C'),
      node('E', 'D'),
      node('F', 'F'),
      node('G', 'A'),
    ]);
    expect(layers).toEqual({ columns: [['A'], ['G']], loop: ['B', 'C', 'D', 'E', 'F'] });
  });
});
