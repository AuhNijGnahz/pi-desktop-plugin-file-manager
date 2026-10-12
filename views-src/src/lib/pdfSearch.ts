/** Regex search on PDF.js 6.4.299's normalized page contents. PDF.js continues
 * to extract text, remove line-end hyphens, expand ligatures, map returned
 * offsets to the original text layer, count matches, navigate and highlight.
 * Never interpret match()'s query argument as regex: it was normalized as text.
 */
export type PdfSearchOptions = { caseSensitive: boolean; entireWord: boolean; regex: boolean };
export const DEFAULT_PDF_SEARCH_OPTIONS: PdfSearchOptions = { caseSensitive: false, entireWord: false, regex: false };
export type PdfSearchMatch = { index: number; length: number };

// Same compatibility replacements as PDF.js 6.4.299 pdf_find_controller.js
// (Mozilla, Apache-2.0); apply these to literals only, never to regex syntax.
const PDF_CHARACTER_REPLACEMENTS = new Map([
  ["\u2010", "-"], ["\u2018", "'"], ["\u2019", "'"], ["\u201A", "'"], ["\u201B", "'"],
  ["\u201C", '"'], ["\u201D", '"'], ["\u201E", '"'], ["\u201F", '"'],
  ["\u00BC", "1/4"], ["\u00BD", "1/2"], ["\u00BE", "3/4"],
]);
const REGEX_META = new Set(["\\", "^", "$", ".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|"]);

function normalizedPdfLiteral(value: string): string {
  let result = "";
  for (const character of value.normalize("NFD")) {
    // PDF.js's compatibility table covers BMP non-mark characters only.
    result += PDF_CHARACTER_REPLACEMENTS.get(character)
      ?? (character.length === 1 && !/\p{M}/u.test(character) ? character.normalize("NFKC") : character);
  }
  return result.normalize("NFC");
}

function escapeLiteral(value: string, inClass = false): string {
  let result = "";
  for (const character of value) {
    const special = inClass ? "\\[]^-".includes(character) : REGEX_META.has(character);
    result += special ? `\\${character}` : character;
  }
  return result;
}

type RegexToken = { next: number; source?: string; literal?: string };

/** Decode literal escapes; preserve operators, property escapes, named and
 * numeric backreferences. Original syntax is validated before transformation. */
function readEscape(source: string, index: number): RegexToken {
  const tail = source.slice(index);
  const hex = /^\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))/.exec(tail);
  if (hex) return { next: index + hex[0].length, literal: String.fromCodePoint(parseInt(hex[1] ?? hex[2] ?? hex[3], 16)) };
  const property = /^\\[pP]\{[^}]+\}/.exec(tail);
  const named = /^\\k<[^>]+>/.exec(tail);
  const control = /^\\c[A-Za-z]/.exec(tail);
  const numeric = /^\\[0-9]+/.exec(tail);
  const preserved = property ?? named ?? control ?? numeric;
  if (preserved) return { next: index + preserved[0].length, source: preserved[0] };
  const character = source[index + 1];
  if (character && "^$.*+?()[]{}|\\/-".includes(character)) return { next: index + 2, literal: character };
  return { next: index + 2, source: source.slice(index, index + 2) };
}

type ClassAtom = { source: string; expanded?: string; range?: boolean };

function normalizeClass(source: string, start: number): RegexToken {
  const negated = source[start + 1] === "^";
  const atoms: ClassAtom[] = [];
  let index = start + (negated ? 2 : 1);
  while (source[index] !== "]") {
    const character = source[index];
    if (character === undefined) throw new SyntaxError("Unclosed class");
    if (character === "-") {
      atoms.push({ source: "-", range: true });
      index += 1;
      continue;
    }
    const token = character === "\\" ? readEscape(source, index)
      : { literal: String.fromCodePoint(source.codePointAt(index)!), next: index + (source.codePointAt(index)! > 0xffff ? 2 : 1) };
    if (token.literal === undefined) atoms.push({ source: token.source! });
    else {
      const normalized = normalizedPdfLiteral(token.literal);
      const expanded = [...normalized].length > 1;
      atoms.push({ source: expanded ? "" : escapeLiteral(normalized, true), expanded: expanded ? escapeLiteral(normalized) : undefined });
    }
    index = token.next;
  }
  const expanded = atoms.flatMap((atom) => atom.expanded ? [atom.expanded] : []);
  for (let atom = 0; atom < atoms.length; atom++) {
    if (!atoms[atom].range || atom === 0 || atom === atoms.length - 1) continue;
    // A regex range/complement operates on single code points; a ligature or
    // fraction which expands into a sequence cannot be its endpoint safely.
    if (atoms[atom - 1].expanded || atoms[atom + 1].expanded) throw new SyntaxError("Expanded range endpoint");
  }
  if (negated && expanded.length) throw new SyntaxError("Expanded negated class");
  const base = atoms.map((atom) => atom.source).join("");
  const classSource = `[${negated ? "^" : ""}${base}]`;
  // Prefer longer expansions over single-character alternatives in a class.
  // Noncapturing groups keep existing backreferences and quantifiers intact.
  const normalized = expanded.length ? `(?:${[...expanded.sort((a, b) => b.length - a.length), ...(base ? [classSource] : [])].join("|")})` : classSource;
  return { source: normalized, next: index + 1 };
}

function normalizeRegexSource(source: string): string {
  let result = "";
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (character === "[") {
      const token = normalizeClass(source, index);
      result += token.source;
      index = token.next;
      continue;
    }
    // Preserve group identifiers/modifiers and quantifier spelling as syntax.
    const header = character === "(" ? /^\(\?(?:<[^=!][^>]*>|[ims-]+:)/.exec(source.slice(index)) : null;
    const quantifier = character === "{" ? /^\{\d+(?:,\d*)?\}/.exec(source.slice(index)) : null;
    if (header || quantifier) {
      const token = (header ?? quantifier)![0];
      result += token;
      index += token.length;
      continue;
    }
    const token = character === "\\" ? readEscape(source, index)
      : { literal: String.fromCodePoint(source.codePointAt(index)!), next: index + (source.codePointAt(index)! > 0xffff ? 2 : 1) };
    if (token.literal === undefined) result += token.source;
    else if (character !== "\\" && REGEX_META.has(character)) result += character;
    else {
      const normalized = normalizedPdfLiteral(token.literal);
      const literal = escapeLiteral(normalized);
      result += [...normalized].length > 1 ? `(?:${literal})` : literal;
    }
    index = token.next;
  }
  return result;
}

/** ECMAScript Unicode regex; the case toggle supplies i. Literal compatibility
 * characters expand as single atoms: ﬃ+ => (?:ffi)+, [ﬃa] => (?:ffi|[a]).
 * Expanding negated classes/range endpoints is rejected rather than silently
 * changing their meaning. Explicit combining-mark syntax addresses the NFC
 * text below; composed é / \u00e9 work, e\u0301 targets a decomposed sequence.
 */
export function compilePdfRegex(query: string, caseSensitive = false): RegExp | null {
  try {
    const flags = caseSensitive ? "gu" : "giu";
    new RegExp(query, flags); // Validate before normalization can alter syntax.
    return new RegExp(normalizeRegexSource(query), flags);
  } catch {
    return null;
  }
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Same adjacent-grapheme word boundaries as PDF.js 6.4.299 pdf_find_utils.js
 * (Mozilla, Apache-2.0). Using \b would mishandle Chinese and accented text. */
function isEntireWord(content: string, index: number, length: number): boolean {
  const graphemes = graphemeSegmenter.segment(content);
  const isBreak = (position: number) => {
    const after = graphemes.containing(position)!;
    if (after.index !== position) return false;
    const before = graphemes.containing(position - 1)!.segment;
    return wordSegmenter.segment(before + after.segment).containing(before.length)!.index === before.length;
  };
  const end = index + length;
  return (index === 0 || isBreak(index)) && (end === content.length || isBreak(end));
}

type RegexPage = { text: string; starts?: Uint32Array; ends?: Uint32Array };

/** A canonical NFC view avoids splitting one accented/Hangul letter into
 * several regex hits. Offsets are mapped back to match()'s normalized contents,
 * then PDF.js applies its existing original-text mapping. No PDF is re-parsed.
 * Line-end spaces / joined hyphenated words follow PDF.js normalization; regex
 * is page-local. It is accent-sensitive and uses native JS Unicode semantics.
 */
function regexPage(content: string): RegexPage {
  const text = content.normalize("NFC");
  if (text === content) return { text };
  const starts = new Uint32Array(text.length);
  const ends = new Uint32Array(text.length);
  let output = 0;
  for (const { segment, index } of graphemeSegmenter.segment(content)) {
    const composed = segment.normalize("NFC");
    if (composed === segment) {
      for (let unit = 0; unit < segment.length; unit++) {
        starts[output] = index + unit;
        ends[output++] = index + unit + 1;
      }
      continue;
    }
    const decomposed = segment.normalize("NFD") === segment;
    let input = index;
    for (const point of composed) {
      const end = decomposed ? input + point.normalize("NFD").length : index + segment.length;
      for (let unit = 0; unit < point.length; unit++) {
        starts[output] = decomposed ? input : index;
        ends[output++] = end;
      }
      input = end;
    }
  }
  return { text, starts, ends };
}

export function findPdfRegexMatches(expression: RegExp, pageContent: string, entireWord = false, maxMatches = Infinity): PdfSearchMatch[] {
  const page = regexPage(pageContent);
  const matches: PdfSearchMatch[] = [];
  expression.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(page.text)) !== null) {
    if (!match[0].length) {
      // exec() leaves lastIndex unchanged for empty matches. Advance a Unicode
      // code point (also past EOF) so anchors/lookarounds/empty alternatives end.
      expression.lastIndex = match.index + ((page.text.codePointAt(match.index) ?? 0) > 0xffff ? 2 : 1);
      continue;
    }
    const index = page.starts?.[match.index] ?? match.index;
    const end = page.ends?.[match.index + match[0].length - 1] ?? match.index + match[0].length;
    if (!entireWord || isEntireWord(pageContent, index, end - index)) {
      if (matches.length >= maxMatches) throw new RangeError("PDF regex match limit exceeded");
      matches.push({ index, length: end - index });
    }
  }
  return matches;
}
