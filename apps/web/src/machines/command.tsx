import { useState } from 'react';

/**
 * A command to type in the machine's terminal, with **Copy** when the browser allows it (the
 * clipboard needs a secure address such as `localhost`).
 */
export function Command({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  return (
    <div className="mt-1 flex items-start gap-2">
      <pre
        aria-label={label}
        className="min-w-0 flex-1 overflow-x-auto rounded bg-slate-900 px-3 py-2 text-sm text-white"
      >
        <code>{command}</code>
      </pre>
      {clipboard && (
        <button
          type="button"
          className="shrink-0 rounded border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50"
          onClick={() => {
            void clipboard.writeText(command).then(() => {
              setCopied(true);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}
    </div>
  );
}
