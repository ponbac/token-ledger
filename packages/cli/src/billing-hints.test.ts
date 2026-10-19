import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { billingHintsDirectory } from "./billing-hints.ts";

describe("local billing hints discovery", () => {
  it("uses local Windows data, macOS support, and Linux XDG data rather than roaming settings", () => {
    assert.strictEqual(
      billingHintsDirectory("win32", "C:\\Users\\Martin", Option.some("D:\\Local"), Option.none()),
      "D:\\Local\\token-ledger\\billing-hints",
    );
    assert.strictEqual(
      billingHintsDirectory("win32", "C:\\Users\\Martin", Option.none(), Option.none()),
      "C:\\Users\\Martin\\AppData\\Local\\token-ledger\\billing-hints",
    );
    assert.strictEqual(
      billingHintsDirectory("darwin", "/Users/me", Option.none(), Option.some("/ignored")),
      "/Users/me/Library/Application Support/token-ledger/billing-hints",
    );
    assert.strictEqual(
      billingHintsDirectory("linux", "/home/me", Option.none(), Option.some("/data")),
      "/data/token-ledger/billing-hints",
    );
    assert.strictEqual(
      billingHintsDirectory("linux", "/home/me", Option.none(), Option.none()),
      "/home/me/.local/share/token-ledger/billing-hints",
    );
  });
});
