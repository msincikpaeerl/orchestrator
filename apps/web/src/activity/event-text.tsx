import type { EventLogEntry } from '@orchestrator/protocol';
import { Link } from 'react-router';
import { eventText } from './text';

/** An event in plain words; quoted content is text, never Markdown or HTML. */
export function EventText({ entry }: { entry: EventLogEntry }) {
  return (
    <>
      {eventText(entry).map((piece, index) =>
        typeof piece === 'string' ? (
          piece
        ) : (
          <Link key={index} to={piece.to} className="break-words text-blue-700 underline">
            {piece.text}
          </Link>
        ),
      )}
    </>
  );
}
