import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { dependencyLayers } from './dependency-depth';

/**
 * The dependency graph (02, sections 5.3 and 6.3; owner's answers 14 of lot 5 step A and 2 to 9 of
 * step H), drawn with no new dependency: one column per dependency depth, side by side with
 * arrows from each ticket to the tickets waiting for it on a wide screen; on a phone, the same
 * columns one below the other, a list by depth. Every card also says what it waits for in words.
 */
export interface GraphItem {
  id: string;
  /** How the ticket is named in "Waits for …": `WEB-3`, or a plan ticket's key. */
  name: string;
  /** The ids of the tickets it waits for; ids not in the graph are ignored. */
  waitsFor: readonly string[];
  /** The card's accessible name. */
  label: string;
  content: ReactNode;
}

/** The column headings (owner's answer 5). */
export function stepHeading(index: number): string {
  return index === 0 ? 'Step 1 · waits for nothing' : `Step ${String(index + 1)}`;
}
export const LOOP_HEADING = 'Waits in a loop';

/** "Waits for WEB-3, WEB-5." or null when it waits for nothing in the graph. */
export function waitsForText(names: readonly string[]): string | null {
  return names.length === 0 ? null : `Waits for ${names.join(', ')}.`;
}

interface Arrow {
  key: string;
  path: string;
}

const NODE = 'data-graph-node';

/** A curve from the middle of the blocker's right edge to the middle of the waiting card's left. */
function arrowsOf(inner: HTMLElement, items: readonly GraphItem[]): Arrow[] {
  const origin = inner.getBoundingClientRect();
  const boxes = new Map<string, DOMRect>();
  for (const element of inner.querySelectorAll<HTMLElement>(`[${NODE}]`)) {
    const id = element.getAttribute(NODE);
    if (id !== null) boxes.set(id, element.getBoundingClientRect());
  }
  const arrows: Arrow[] = [];
  for (const item of items) {
    const to = boxes.get(item.id);
    if (!to) continue;
    for (const blocker of item.waitsFor) {
      const from = boxes.get(blocker);
      // Only forward: a blocker to the left (always, but for a loop's column).
      if (!from || from.right > to.left) continue;
      const x1 = from.right - origin.left;
      const y1 = from.top + from.height / 2 - origin.top;
      const x2 = to.left - origin.left - 2;
      const y2 = to.top + to.height / 2 - origin.top;
      const bend = Math.max(16, (x2 - x1) / 2);
      arrows.push({
        key: `${blocker}>${item.id}`,
        path: `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + bend).toFixed(1)} ${y1.toFixed(1)}, ${(x2 - bend).toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`,
      });
    }
  }
  return arrows;
}

export function DependencyGraph({
  label,
  items,
  hidden,
  headingLevel = 3,
}: {
  label: string;
  /** The columns' heading level: 4 under a part's own heading (the plan's "Dependencies"). */
  headingLevel?: 3 | 4;
  items: readonly GraphItem[];
  /** Tickets the filters hide: their cards go, but every column stays where it is (answer 3). */
  hidden?: ReadonlySet<string>;
}) {
  const marker = `arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const inner = useRef<HTMLDivElement>(null);
  const [arrows, setArrows] = useState<Arrow[]>([]);
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const layers = useMemo(() => dependencyLayers(items), [items]);
  const shown = useMemo(
    () => items.filter((item) => !(hidden?.has(item.id) ?? false)),
    [items, hidden],
  );

  const measure = useCallback(() => {
    if (!inner.current) return;
    const next = arrowsOf(inner.current, shown);
    setArrows((previous) =>
      previous.length === next.length &&
      previous.every((arrow, index) => arrow.path === next[index]?.path)
        ? previous
        : next,
    );
  }, [shown]);

  useLayoutEffect(() => {
    measure();
    const element = inner.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const card of element.querySelectorAll(`[${NODE}]`)) observer.observe(card);
    return () => {
      observer.disconnect();
    };
  }, [measure]);

  const columns = [
    ...layers.columns.map((ids, index) => ({ heading: stepHeading(index), ids })),
    ...(layers.loop.length > 0 ? [{ heading: LOOP_HEADING, ids: layers.loop }] : []),
  ];

  return (
    <div role="region" aria-label={label} className="min-w-0 sm:overflow-x-auto">
      <div ref={inner} className="relative flex flex-col gap-3 sm:w-max sm:flex-row sm:gap-12">
        {columns.map((column) => (
          <GraphColumn
            key={column.heading}
            heading={column.heading}
            level={headingLevel}
            items={column.ids.flatMap((id) => {
              const item = byId.get(id);
              return item && !(hidden?.has(id) ?? false) ? [item] : [];
            })}
            nameOf={(id) => byId.get(id)?.name}
          />
        ))}
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 hidden h-full w-full overflow-visible text-slate-500 sm:block"
        >
          <defs>
            <marker
              id={marker}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          {arrows.map((arrow) => (
            <path
              key={arrow.key}
              d={arrow.path}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              markerEnd={`url(#${marker})`}
            />
          ))}
        </svg>
      </div>
    </div>
  );
}

function GraphColumn({
  heading,
  level,
  items,
  nameOf,
}: {
  heading: string;
  level: 3 | 4;
  items: readonly GraphItem[];
  nameOf: (id: string) => string | undefined;
}) {
  const id = useId();
  const Heading = level === 3 ? 'h3' : 'h4';
  return (
    <section aria-labelledby={id} className="min-w-0 space-y-2 rounded-lg bg-slate-100 p-3 sm:w-64">
      <Heading id={id} className="font-semibold text-slate-900">
        {heading}
      </Heading>
      {items.length === 0 ? (
        <p className="text-sm text-slate-600">No tickets shown</p>
      ) : (
        <ul aria-label={heading} className="space-y-2">
          {items.map((item) => {
            const waits = waitsForText(
              item.waitsFor.flatMap((blocker) => {
                const name = nameOf(blocker);
                return name === undefined ? [] : [name];
              }),
            );
            return (
              <li
                key={item.id}
                {...{ [NODE]: item.id }}
                aria-label={item.label}
                className="relative z-10 min-w-0 rounded border border-slate-200 bg-white p-3 shadow-sm"
              >
                {item.content}
                {waits !== null && (
                  <p className="mt-1 text-sm break-words text-slate-700">{waits}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
