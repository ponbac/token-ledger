import { Option } from "effect";
import {
  type Node,
  type ParseError,
  getNodeValue,
  parseTree,
  visit,
} from "jsonc-parser/lib/esm/main.js";

/** A top-level property to set: its key and a scalar value. */
export type Property = readonly [key: string, value: boolean | string];

/** A property that had to be written, with the source text of the value it replaced. */
export interface Changed {
  readonly key: string;
  /** The new value as JSON. */
  readonly value: string;
  readonly previous: Option.Option<string>;
}

/** An edited document and what was changed in it; `changes` is empty when nothing was. */
export interface Edited {
  readonly text: string;
  readonly changes: ReadonlyArray<Changed>;
}

/** Replaces `length` characters at `offset` with `text`; a zero `length` inserts. */
interface Splice {
  readonly offset: number;
  readonly length: number;
  readonly text: string;
}

interface Member {
  readonly key: Node;
  readonly value: Node;
}

/** A parsed document: its root value when it has one, and the comments and commas around it. */
interface Parsed {
  readonly root: Option.Option<Node>;
  readonly comments: ReadonlyArray<{ readonly offset: number; readonly length: number }>;
  readonly commas: ReadonlyArray<number>;
}

const parseOptions = { allowTrailingComma: true, allowEmptyContent: true };

const defaultIndent = "    ";

/** Parses JSONC as VS Code reads `settings.json`; `None` on any syntax error. */
function parse(text: string): Option.Option<Parsed> {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, parseOptions);
  const comments: Array<{ readonly offset: number; readonly length: number }> = [];
  const commas: number[] = [];

  visit(
    text,
    {
      onComment: (offset, length) => {
        comments.push({ offset, length });
      },
      onSeparator: (character, offset) => {
        if (character === ",") commas.push(offset);
      },
    },
    parseOptions,
  );

  return errors.length > 0
    ? Option.none()
    : Option.some({ root: Option.fromUndefinedOr(root), comments, commas });
}

function members(root: Node): ReadonlyArray<Member> {
  return (root.children ?? []).flatMap((property) => {
    const [key, value] = property.children ?? [];

    return key === undefined || value === undefined ? [] : [{ key, value }];
  });
}

/** The whitespace before `offset` on its line, or `None` when something else precedes it. */
function indentAt(text: string, offset: number): Option.Option<string> {
  const prefix = text.slice(text.lastIndexOf("\n", offset - 1) + 1, offset);

  return /^[ \t]*$/.test(prefix) ? Option.some(prefix) : Option.none();
}

/** Offset of the first line terminator in `[from, to)` that is not inside a comment. */
function lineBreak(text: string, parsed: Parsed, from: number, to: number): Option.Option<number> {
  let index = from;

  while (index < to) {
    const position = index;

    const comment = parsed.comments.find(
      (range) => position >= range.offset && position < range.offset + range.length,
    );

    if (comment !== undefined) index = comment.offset + comment.length;
    else if (text[index] === "\n" || (text[index] === "\r" && text[index + 1] === "\n"))
      return Option.some(index);
    else index++;
  }

  return Option.none();
}

/**
 * How to add `lines` to the object `root`: after its last member, or into an empty object.
 * They go after the rest of the line they follow, so a comment there keeps its place.
 */
function additions(
  text: string,
  parsed: Parsed,
  root: Node,
  lines: ReadonlyArray<string>,
): ReadonlyArray<Splice> {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const close = root.offset + root.length - 1;
  const last = members(root).at(-1);

  if (last === undefined) {
    const outer = Option.getOrElse(indentAt(text, root.offset), () => "");
    const body = lines.map((line) => `${eol}${outer}${defaultIndent}${line}`).join(",");

    return [
      Option.match(lineBreak(text, parsed, root.offset + 1, close), {
        // The braces share a line, so the closing one moves below the additions.
        onNone: () => ({ offset: root.offset + 1, length: 0, text: `${body}${eol}${outer}` }),
        onSome: (offset) => ({ offset, length: 0, text: body }),
      }),
    ];
  }

  const end = last.value.offset + last.value.length;
  // A comma between the last value and the closing brace is the object's trailing comma.
  const comma = parsed.commas.find((offset) => offset >= end && offset < close);
  const indent = Option.getOrElse(indentAt(text, last.key.offset), () => defaultIndent);

  return Option.match(lineBreak(text, parsed, comma === undefined ? end : comma + 1, close), {
    // The object closes on the last member's line, so the additions stay on that line too.
    onNone: () => [
      comma === undefined
        ? { offset: end, length: 0, text: lines.map((line) => `, ${line}`).join("") }
        : { offset: comma + 1, length: 0, text: lines.map((line) => ` ${line},`).join("") },
    ],
    onSome: (offset) =>
      comma === undefined
        ? [
            // The comma follows the value directly, ahead of any comment on that line.
            {
              offset: end,
              length: offset - end,
              text: `,${text.slice(end, offset)}${lines.map((line) => `${eol}${indent}${line}`).join(",")}`,
            },
          ]
        : [{ offset, length: 0, text: lines.map((line) => `${eol}${indent}${line},`).join("") }],
  });
}

const spliced = (text: string, splices: ReadonlyArray<Splice>) =>
  splices
    .toSorted((a, b) => b.offset - a.offset)
    .reduce(
      (result, splice) =>
        `${result.slice(0, splice.offset)}${splice.text}${result.slice(splice.offset + splice.length)}`,
      text,
    );

/** Every member as `key=value` JSON in document order, with `keys` left out. */
const others = (root: Node, keys: ReadonlySet<string>) =>
  members(root)
    .filter(({ key }) => !keys.has(String(key.value)))
    .map(({ key, value }) => `${JSON.stringify(key.value)}=${JSON.stringify(getNodeValue(value))}`)
    .join("\n");

/** Whether `root` holds each of `properties` exactly once. */
const holds = (root: Node, properties: ReadonlyArray<Property>) =>
  properties.every(([key, value]) => {
    const found = members(root).filter((member) => member.key.value === key);

    return found.length === 1 && found.every((member) => getNodeValue(member.value) === value);
  });

/**
 * Sets top-level properties of the object in the JSONC `source`. A property that is present has
 * only its value replaced; absent ones are added after the last property. Every other character
 * stays as it was, including comments, trailing commas, indentation, and line endings. A
 * document with no value becomes an object.
 *
 * `None` when `source` has a syntax error, its root is not an object, or it repeats one of the
 * keys, where an edit could not be trusted to set the value an editor reads.
 */
export function setProperties(
  source: string,
  properties: ReadonlyArray<Property>,
): Option.Option<Edited> {
  const mark = source.startsWith("﻿") ? "﻿" : "";
  const text = source.slice(mark.length);
  const keys = new Set(properties.map(([key]) => key));
  const rendered = ([key, value]: Property) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  const parsed = parse(text);

  if (Option.isNone(parsed)) return Option.none();

  if (Option.isNone(parsed.value.root)) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lead = text === "" || text.endsWith("\n") ? text : `${text}${eol}`;
    const body = properties.map((property) => `${defaultIndent}${rendered(property)}`);

    return Option.some({
      text: `${mark}${lead}{${eol}${body.join(`,${eol}`)}${eol}}${eol}`,
      changes: properties.map(([key, value]) => ({
        key,
        value: JSON.stringify(value),
        previous: Option.none(),
      })),
    });
  }

  const root = parsed.value.root.value;

  if (root.type !== "object") return Option.none();

  const changes: Changed[] = [];
  const splices: Splice[] = [];
  const missing: Property[] = [];

  for (const property of properties) {
    const [key, value] = property;
    const found = members(root).filter((member) => member.key.value === key);
    const [member] = found;

    if (found.length > 1) return Option.none();

    if (member !== undefined && getNodeValue(member.value) === value) continue;

    changes.push({
      key,
      value: JSON.stringify(value),
      previous: Option.map(Option.fromUndefinedOr(member), ({ value: node }) =>
        text.slice(node.offset, node.offset + node.length),
      ),
    });

    if (member === undefined) missing.push(property);
    else
      splices.push({
        offset: member.value.offset,
        length: member.value.length,
        text: JSON.stringify(value),
      });
  }

  if (missing.length > 0)
    splices.push(...additions(text, parsed.value, root, missing.map(rendered)));

  const edited = spliced(text, splices);

  // The edit is positional, so confirm what a reader of the result sees before trusting it.
  return Option.flatMap(parse(edited), (result) =>
    Option.match(result.root, {
      onNone: () => Option.none(),
      onSome: (object) =>
        object.type === "object" &&
        holds(object, properties) &&
        others(object, keys) === others(root, keys)
          ? Option.some({ text: `${mark}${edited}`, changes })
          : Option.none(),
    }),
  );
}
