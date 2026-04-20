import type { ReactNode } from 'react';

/**
 * Strip and format LLM output that occasionally leaks markdown artifacts
 * despite the prompt ban (*** ** ``` '''). Fenced blocks are dropped entirely;
 * paired asterisk runs become <strong>/<em>; stray single delimiters are removed.
 */
export function renderInterviewerText(input: string): ReactNode {
  if (!input) return input;

  let text = input;

  // Drop fenced code blocks entirely: ```anything```
  text = text.replace(/```[\s\S]*?```/g, '');
  // Drop stray opening/closing fence markers that never paired up
  text = text.replace(/```+/g, '');
  // Drop quote-delimiter runs ('''+, """+) — these are the paired markers the
  // prompt bans from leaking into the stream
  text = text.replace(/'{3,}/g, '');
  text = text.replace(/"{3,}/g, '');
  // Collapse leftover whitespace from removals
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // Tokenize paired asterisk markers into JSX nodes.
  // Order matters: *** first (bold+italic), then ** (bold), then * (italic).
  const nodes: ReactNode[] = [];
  let remaining = text;
  let key = 0;

  const patterns: Array<{ re: RegExp; wrap: (inner: string, k: number) => ReactNode }> = [
    {
      re: /\*\*\*([^*\n][^*]*?)\*\*\*/,
      wrap: (inner, k) => (
        <strong key={k}>
          <em>{inner}</em>
        </strong>
      ),
    },
    {
      re: /\*\*([^*\n][^*]*?)\*\*/,
      wrap: (inner, k) => <strong key={k}>{inner}</strong>,
    },
    {
      re: /\*([^*\n][^*]*?)\*/,
      wrap: (inner, k) => <em key={k}>{inner}</em>,
    },
  ];

  while (remaining.length > 0) {
    let earliest: { idx: number; len: number; node: ReactNode } | null = null;

    for (const { re, wrap } of patterns) {
      const match = remaining.match(re);
      if (match && match.index !== undefined) {
        if (!earliest || match.index < earliest.idx) {
          earliest = {
            idx: match.index,
            len: match[0].length,
            node: wrap(match[1], key++),
          };
        }
      }
    }

    if (!earliest) {
      // No more markers — strip any leftover unpaired * or ` and push the rest.
      nodes.push(remaining.replace(/[*`]/g, ''));
      break;
    }

    if (earliest.idx > 0) {
      const plain = remaining.slice(0, earliest.idx).replace(/[*`]/g, '');
      if (plain) nodes.push(plain);
    }
    nodes.push(earliest.node);
    remaining = remaining.slice(earliest.idx + earliest.len);
  }

  return <>{nodes}</>;
}
