import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const gnuTar = spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout.includes("GNU tar");
const skip = gnuTar ? false : "needs GNU tar for the release build";
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

function temp(name: string): string {
  return mkdtempSync(join(tmpdir(), `bob-${name}-`));
}

function build(out: string) {
  return spawnSync("sh", [join(root, "scripts", "build-release.sh"), out], { encoding: "utf8" });
}

function extract(out: string): string {
  const dest = temp("extract");
  const result = spawnSync("tar", ["-xzf", join(out, `bob-${version}.tar.gz`), "-C", dest], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  return join(dest, `bob-${version}`);
}

function fakeNode(): string {
  const dir = temp("fakenode");
  const path = join(dir, "node");
  writeFileSync(path, '#!/bin/sh\necho v24.1.0\n');
  chmodSync(path, 0o755);

  return dir;
}

test("build-release makes a tarball with a fixed file list", { skip }, () => {
  const out = temp("out");
  const result = build(out);
  assert.equal(result.status, 0, result.stderr);
  const listing = spawnSync("tar", ["-tzf", join(out, `bob-${version}.tar.gz`)], { encoding: "utf8" }).stdout.trim().split("\n");
  const prefix = `bob-${version}/`;
  assert.ok(listing.every((entry) => entry.startsWith(prefix)));

  for (const required of ["bin/bob.ts", "src/view.ts", "layouts/bob.kdl", "package.json", "README.md", "install.sh"]) {
    assert.ok(listing.includes(prefix + required), required);
  }

  assert.ok(!listing.some((entry) => entry.includes("tests/") || entry.includes("node_modules")));
  const sorted = [...listing].sort();
  assert.deepEqual(listing, sorted);
});

test("build-release is deterministic", { skip }, () => {
  const a = temp("out");
  const b = temp("out");
  assert.equal(build(a).status, 0);
  assert.equal(build(b).status, 0);
  assert.deepEqual(
    readFileSync(join(a, `bob-${version}.tar.gz`)),
    readFileSync(join(b, `bob-${version}.tar.gz`)),
  );
});

test("install.sh refuses Node below 26 and writes nothing", { skip }, () => {
  const out = temp("out");
  assert.equal(build(out).status, 0);
  const pkg = extract(out);
  const prefix = join(temp("prefix"), "bob");
  const bin = join(temp("bin"), "bin");
  const env = { ...process.env, PATH: `${fakeNode()}${delimiter}${process.env.PATH}`, BOB_PREFIX: prefix, BOB_BIN: bin };
  const result = spawnSync("sh", [join(pkg, "install.sh")], { env, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Node 26/);
  assert.match(result.stderr, /v24\.1\.0/);
  assert.ok(!existsSync(prefix));
  assert.ok(!existsSync(bin));
});

test("install.sh refuses when node is missing", { skip }, () => {
  const out = temp("out");
  assert.equal(build(out).status, 0);
  const pkg = extract(out);
  const empty = temp("empty");
  const sh = spawnSync("sh", ["-c", "command -v sh"], { encoding: "utf8" }).stdout.trim();
  const env = { PATH: `${empty}${delimiter}${dirname(sh)}`, BOB_PREFIX: join(empty, "p"), BOB_BIN: join(empty, "b") };
  const nodeDir = dirname(process.execPath);

  if (dirname(sh) === nodeDir) return;
  const result = spawnSync("sh", [join(pkg, "install.sh")], { env, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Node 26/);
});

test("install.sh installs and the linked bob runs through the symlink", { skip }, () => {
  const out = temp("out");
  assert.equal(build(out).status, 0);
  const pkg = extract(out);
  const prefix = join(temp("prefix"), "bob");
  const bin = join(temp("bin"), "nested", "bin");
  const state = temp("state");
  const env = { ...process.env, BOB_PREFIX: prefix, BOB_BIN: bin, BOB_STATE_DIR: state, HOME: temp("home") };
  const result = spawnSync("sh", [join(pkg, "install.sh")], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(prefix, "bin", "bob.ts")));
  assert.ok(existsSync(join(prefix, "src", "view.ts")));
  assert.ok(existsSync(join(prefix, "layouts", "bob.kdl")));
  assert.ok(existsSync(join(prefix, "install.sh")));
  assert.deepEqual(readdirSync(bin), ["bob"]);

  const run = spawnSync(join(bin, "bob"), ["--once"], { env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /no sessions/);

  const again = spawnSync("sh", [join(pkg, "install.sh")], { env, encoding: "utf8" });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(spawnSync(join(bin, "bob"), ["--once"], { env, encoding: "utf8" }).status, 0);
});

test("install.sh replaces an old install and its symlink", { skip }, () => {
  const out = temp("out");
  assert.equal(build(out).status, 0);
  const pkg = extract(out);
  const prefix = join(temp("prefix"), "bob");
  mkdirSync(join(prefix, "src"), { recursive: true });
  writeFileSync(join(prefix, "src", "stale.ts"), "x");
  const bin = temp("bin");
  const env = { ...process.env, BOB_PREFIX: prefix, BOB_BIN: bin };
  const result = spawnSync("sh", [join(pkg, "install.sh")], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(join(prefix, "src", "stale.ts")));
});
