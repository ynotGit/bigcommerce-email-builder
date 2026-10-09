// Colour for the terminal: green for what worked, orange for what needs a
// look, red for what failed. Output that is not going to a terminal (a pipe, a
// file, a CI log) stays plain text, as it does when NO_COLOR is set.
type Stream = NodeJS.WriteStream;

/** How many colours the stream shows, as Node counts them: 1 is none, 8 is 256 colours. */
function depth(stream: Stream): number {
  const force = process.env.FORCE_COLOR;
  if (force) return force === '0' ? 1 : 8;
  if (process.env.NO_COLOR) return 1;
  return stream.isTTY ? stream.getColorDepth() : 1;
}

const paint = (code: (colours: number) => string) => (text: string, stream: Stream = process.stdout): string => {
  const colours = depth(stream);
  return colours > 1 ? `\x1b[${code(colours)}m${text}\x1b[39m` : text;
};

export const success = paint(() => '32');
/** Orange needs 256 colours. A terminal with fewer gets yellow. */
export const warning = paint((colours) => (colours >= 8 ? '38;5;208' : '33'));
/** Pass process.stderr for text that is written there. */
export const failure = paint(() => '31');
