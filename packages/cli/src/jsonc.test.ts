import { assert, describe as suite, it } from "@effect/vitest";
import { Option } from "effect";

import { type Property, setProperties } from "./jsonc.ts";

const properties: ReadonlyArray<Property> = [
  ["otel.enabled", true],
  ["otel.outfile", "C:/Users/me/chat.jsonl"],
];

const edit = (source: string) =>
  Option.match(setProperties(source, properties), {
    onNone: () => "refused",
    onSome: ({ text }) => text,
  });

suite("setProperties", () => {
  it("adds settings after the last one and keeps comments, commas, and spacing as they were", () => {
    const source = `// My settings
{
    /* appearance */
    "workbench.colorTheme": "Dark", // the good one
    "editor.rulers": [80,   120,],
    "files.exclude": { "**/.git": true, },   // trailing commas everywhere
    // "otel.enabled": false,
}
`;

    assert.strictEqual(
      edit(source),
      `// My settings
{
    /* appearance */
    "workbench.colorTheme": "Dark", // the good one
    "editor.rulers": [80,   120,],
    "files.exclude": { "**/.git": true, },   // trailing commas everywhere
    "otel.enabled": true,
    "otel.outfile": "C:/Users/me/chat.jsonl",
    // "otel.enabled": false,
}
`,
    );
  });

  it("gives the last setting its comma without moving the comment beside it", () => {
    assert.strictEqual(
      edit('{\n  "a": 1 // why\n}\n'),
      '{\n  "a": 1, // why\n  "otel.enabled": true,\n  "otel.outfile": "C:/Users/me/chat.jsonl"\n}\n',
    );
    assert.strictEqual(
      edit('{\n\t"a": 1 /* spans\n\tlines */\n}'),
      '{\n\t"a": 1, /* spans\n\tlines */\n\t"otel.enabled": true,\n\t"otel.outfile": "C:/Users/me/chat.jsonl"\n}',
    );
  });

  it("replaces only the value of a setting that is present", () => {
    const edited = setProperties(
      '{\n  "otel.outfile": "/old/file.jsonl", // was elsewhere\n  "otel.enabled": false,\n  "z": 1\n}\n',
      properties,
    );

    assert.deepStrictEqual(
      Option.getOrThrow(edited).changes.map(({ key, previous }) => [
        key,
        Option.getOrNull(previous),
      ]),
      [
        ["otel.enabled", "false"],
        ["otel.outfile", '"/old/file.jsonl"'],
      ],
    );
    assert.strictEqual(
      Option.getOrThrow(edited).text,
      '{\n  "otel.outfile": "C:/Users/me/chat.jsonl", // was elsewhere\n  "otel.enabled": true,\n  "z": 1\n}\n',
    );
  });

  it("changes nothing when every setting already has its value", () => {
    const source =
      '{\r\n  "otel.enabled": true,\r\n  "otel.outfile": "C:\\/Users/me/chat.jsonl"\r\n}';

    const edited = Option.getOrThrow(setProperties(source, properties));

    assert.strictEqual(edited.text, source);
    assert.deepStrictEqual(edited.changes, []);
    assert.strictEqual(edit(edit("{}")), edit("{}"));
  });

  it("follows the file's line endings, byte order mark, and single-line layout", () => {
    assert.strictEqual(
      edit('\uFEFF{\r\n  "a": 1,\r\n  "otel.enabled": false\r\n}\r\n'),
      '\uFEFF{\r\n  "a": 1,\r\n  "otel.enabled": true,\r\n  "otel.outfile": "C:/Users/me/chat.jsonl"\r\n}\r\n',
    );
    assert.strictEqual(
      edit('{ "a": 1 }'),
      '{ "a": 1, "otel.enabled": true, "otel.outfile": "C:/Users/me/chat.jsonl" }',
    );
    assert.strictEqual(
      edit('{"a": 1,}'),
      '{"a": 1, "otel.enabled": true, "otel.outfile": "C:/Users/me/chat.jsonl",}',
    );
  });

  it("fills an empty object or an empty file", () => {
    const filled = '{\n    "otel.enabled": true,\n    "otel.outfile": "C:/Users/me/chat.jsonl"\n}';

    assert.strictEqual(edit("{}"), filled);
    assert.strictEqual(edit("{\n}\n"), `${filled}\n`);
    assert.strictEqual(
      edit("{\n  // nothing yet\n}\n"),
      '{\n    "otel.enabled": true,\n    "otel.outfile": "C:/Users/me/chat.jsonl"\n  // nothing yet\n}\n',
    );
    assert.strictEqual(edit(""), `${filled}\n`);
    assert.strictEqual(edit("// only a comment"), `// only a comment\n${filled}\n`);
  });

  it("adds an item to a list without disturbing what the list holds", () => {
    const include = (source: string) =>
      Option.match(setProperties(source, [], [["sync.ignored", "otel.outfile"]]), {
        onNone: () => "refused",
        onSome: ({ text }) => text,
      });

    assert.strictEqual(include("{}"), '{\n    "sync.ignored": ["otel.outfile"]\n}');
    assert.strictEqual(include('{ "sync.ignored": [] }'), '{ "sync.ignored": ["otel.outfile"] }');
    assert.strictEqual(
      include('{\n  "sync.ignored": [\n    "editor.fontSize", // per screen\n  ],\n  "a": 1\n}\n'),
      '{\n  "sync.ignored": [\n    "editor.fontSize", "otel.outfile", // per screen\n  ],\n  "a": 1\n}\n',
    );

    // Already there, wherever it stands: nothing to write.
    const listed = '{ "sync.ignored": ["otel.outfile", "editor.fontSize"] }';

    assert.strictEqual(include(listed), listed);
    assert.deepStrictEqual(
      Option.getOrThrow(setProperties(listed, [], [["sync.ignored", "otel.outfile"]])).included,
      [],
    );

    // A value that is not a list is not this command's to reshape.
    assert.strictEqual(include('{ "sync.ignored": "otel.outfile" }'), "refused");
  });

  it("refuses a file it cannot edit safely", () => {
    // A syntax error, a root that is not an object, and a key VS Code would read twice.
    for (const source of [
      '{ "a": 1,, }',
      '{ "a": 1',
      "[]",
      '{ "otel.enabled": true, "otel.enabled": false }',
    ])
      assert.strictEqual(edit(source), "refused", source);
  });
});
