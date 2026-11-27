import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EVENTS } from "../src/hook.ts";

const root = join(import.meta.dirname, "..");

function read(...parts: string[]) {
  return JSON.parse(readFileSync(join(root, ...parts), "utf8"));
}

test("marketplace lists one plugin from the plugin folder", () => {
  const marketplace = read(".claude-plugin", "marketplace.json");

  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, "bob");
  assert.equal(marketplace.plugins[0].source, "./plugin");
});

test("hooks.json declares the events that bob install writes", () => {
  const { hooks } = read("plugin", "hooks", "hooks.json");

  assert.deepEqual(Object.keys(hooks).sort(), [...EVENTS].sort());
});

test("every plugin hook runs bob hook", () => {
  const { hooks } = read("plugin", "hooks", "hooks.json");

  for (const entries of Object.values<{ hooks: { type: string; command: string }[] }[]>(hooks)) {
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].hooks, [{ type: "command", command: "bob hook" }]);
  }
});

test("plugin version equals package version", () => {
  const plugin = read("plugin", ".claude-plugin", "plugin.json");

  assert.equal(plugin.name, "bob");
  assert.equal(plugin.version, read("package.json").version);
});
