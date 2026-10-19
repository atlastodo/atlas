/**
 * `text` without its trailing run of `char` (one character), in linear time. A regex such as
 * `/=+$/` backtracks at every `char` that is not at the end, which is quadratic on a long run of
 * them followed by anything else, and these strings come from outside (a server, a config, a
 * pasted secret).
 */
export function trimTrailing(text: string, char: string): string {
  if (char.length !== 1) throw new Error("trimTrailing takes one character");
  let end = text.length;
  while (end > 0 && text[end - 1] === char) end--;
  return end === text.length ? text : text.slice(0, end);
}
