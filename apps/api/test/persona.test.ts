import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { END_MARKER, LANG, VOICE_STYLE } from "../src/persona/research.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const PY = resolve(ROOT, ".venv/bin/python");

describe("persona is identical to the research implementation", () => {
  it.skipIf(!existsSync(PY))("VOICE_STYLE, LANG and END_MARKER match memory/context.py", () => {
    const out = execFileSync(PY, ["-c",
      "import json; from memory.context import VOICE_STYLE, LANG, END_MARKER; print(json.dumps({'v':VOICE_STYLE,'l':LANG,'e':END_MARKER}))"],
    { cwd: ROOT, encoding: "utf8" });
    const py = JSON.parse(out) as { v: string; l: Record<string, [string, string]>; e: string };
    expect(VOICE_STYLE).toBe(py.v);
    expect(END_MARKER).toBe(py.e);
    expect(Object.fromEntries(Object.entries(LANG).map(([k, v]) => [k, [...v]]))).toEqual(py.l);
  });
});
