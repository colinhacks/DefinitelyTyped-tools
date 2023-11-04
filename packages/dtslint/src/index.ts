#!/usr/bin/env node

import { AllTypeScriptVersion, TypeScriptVersion } from "@definitelytyped/typescript-versions";
import assert = require("assert");
import { readFile, existsSync } from "fs-extra";
import { basename, dirname, join as joinPaths, resolve } from "path";

import { assertNever, cleanTypeScriptInstalls, installAllTypeScriptVersions, installTypeScriptNext } from "@definitelytyped/utils";
import { checkPackageJson, checkTsconfig, runAreTheTypesWrong } from "./checks";
import { checkTslintJson, lint, TsVersion } from "./lint";
import { getCompilerOptions, packageNameFromPath, readJson } from "./util";
import { getTypesVersions } from "@definitelytyped/header-parser";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let dirPath = process.cwd();
  let onlyTestTsNext = false;
  let expectOnly = false;
  let shouldListen = false;
  let lookingForTsLocal = false;
  let tsLocal: string | undefined;

  console.log(`dtslint@${require("../package.json").version}`);

  for (const arg of args) {
    if (lookingForTsLocal) {
      if (arg.startsWith("--")) {
        throw new Error("Looking for local path for TS, but got " + arg);
      }
      tsLocal = resolve(arg);
      lookingForTsLocal = false;
      continue;
    }
    switch (arg) {
      case "--installAll":
        console.log("Cleaning old installs and installing for all TypeScript versions...");
        console.log("Working...");
        await cleanTypeScriptInstalls();
        await installAllTypeScriptVersions();
        return;
      case "--localTs":
        lookingForTsLocal = true;
        break;
      case "--version":
        console.log(require("../../package.json").version);
        return;
      case "--expectOnly":
        expectOnly = true;
        break;
      case "--onlyTestTsNext":
        onlyTestTsNext = true;
        break;
      // Only for use by types-publisher.
      // Listens for { path, onlyTestTsNext } messages and outputs { path, status }.
      case "--listen":
        shouldListen = true;
        break;
      default: {
        if (arg.startsWith("--")) {
          console.error(`Unknown option '${arg}'`);
          usage();
          process.exit(1);
        }

        const path =
          arg.indexOf("@") === 0 && arg.indexOf("/") !== -1
            ? // we have a scoped module, e.g. @bla/foo
              // which should be converted to   bla__foo
              arg.slice(1).replace("/", "__")
            : arg;
        dirPath = joinPaths(dirPath, path);
      }
    }
  }
  if (lookingForTsLocal) {
    throw new Error("Path for --localTs was not provided.");
  }

  if (shouldListen) {
    listen(dirPath, tsLocal, onlyTestTsNext);
  } else {
    await installTypeScriptAsNeeded(tsLocal, onlyTestTsNext);
    const output = await runTests(dirPath, onlyTestTsNext, expectOnly, tsLocal);
    if (output) {
      console.log(output);
    }
  }
}

async function installTypeScriptAsNeeded(tsLocal: string | undefined, onlyTestTsNext: boolean): Promise<void> {
  if (tsLocal) return;
  if (onlyTestTsNext) {
    return installTypeScriptNext();
  }
  return installAllTypeScriptVersions();
}

function usage(): void {
  console.error("Usage: dtslint [--version] [--installAll] [--onlyTestTsNext] [--expectOnly] [--localTs path]");
  console.error("Args:");
  console.error("  --version        Print version and exit.");
  console.error("  --installAll     Cleans and installs all TypeScript versions.");
  console.error("  --expectOnly     Run only the ExpectType lint rule.");
  console.error("  --onlyTestTsNext Only run with `typescript@next`, not with the minimum version.");
  console.error("  --localTs path   Run with *path* as the latest version of TS.");
  console.error("");
  console.error("onlyTestTsNext and localTs are (1) mutually exclusive and (2) test a single version of TS");
}

function listen(dirPath: string, tsLocal: string | undefined, alwaysOnlyTestTsNext: boolean): void {
  // Don't await this here to ensure that messages sent during installation aren't dropped.
  const installationPromise = installTypeScriptAsNeeded(tsLocal, alwaysOnlyTestTsNext);
  process.on("message", async (message: unknown) => {
    const { path, onlyTestTsNext, expectOnly } = message as {
      path: string;
      onlyTestTsNext: boolean;
      expectOnly?: boolean;
    };

    await installationPromise;
    runTests(joinPaths(dirPath, path), onlyTestTsNext, !!expectOnly, tsLocal)
      .then(
        () => process.send!({ path, status: "OK" }),
        e => process.send!({ path, status: e.stack })
      )
      .catch((e) => console.error(e.stack));
  });
}

async function runTests(
  dirPath: string,
  onlyTestTsNext: boolean,
  expectOnly: boolean,
  tsLocal: string | undefined
): Promise<string | undefined> {
  // Assert that we're really on DefinitelyTyped.
  const dtRoot = findDTRoot(dirPath);
  const packageName = packageNameFromPath(dirPath);
  assertPathIsInDefinitelyTyped(dirPath, dtRoot);
  assertPathIsNotBanned(packageName);
  assertPackageIsNotDeprecated(packageName, await readFile(joinPaths(dtRoot, "notNeededPackages.json"), "utf-8"));

  const typesVersions = getTypesVersions(dirPath);
  const packageJson = checkPackageJson(dirPath, typesVersions);
  if (Array.isArray(packageJson)) {
    throw new Error("\n\t* " + packageJson.join("\n\t* "));
  }

  const minVersion = maxVersion(packageJson.minimumTypeScriptVersion, TypeScriptVersion.lowest);
  if (onlyTestTsNext || tsLocal) {
    const tsVersion = tsLocal ? "local" : TypeScriptVersion.latest;
    await testTypesVersion(dirPath, tsVersion, tsVersion, expectOnly, tsLocal, /*isLatest*/ true);
  } else {
    // For example, typesVersions of [3.2, 3.5, 3.6] will have
    // associated ts3.2, ts3.5, ts3.6 directories, for
    // <=3.2, <=3.5, <=3.6 respectively; the root level is for 3.7 and above.
    // so this code needs to generate ranges [lowest-3.2, 3.3-3.5, 3.6-3.6, 3.7-latest]
    const lows = [TypeScriptVersion.lowest, ...typesVersions.map(next)];
    const his = [...typesVersions, TypeScriptVersion.latest];
    assert.strictEqual(lows.length, his.length);
    for (let i = 0; i < lows.length; i++) {
      const low = maxVersion(minVersion, lows[i]);
      const hi = his[i];
      assert(
        parseFloat(hi) >= parseFloat(low),
        `'"minimumTypeScriptVersion": "${minVersion}"' in package.json skips ts${hi} folder.`
      );
      const isLatest = hi === TypeScriptVersion.latest;
      const versionPath = isLatest ? dirPath : joinPaths(dirPath, `ts${hi}`);
      if (lows.length > 1) {
        console.log("testing from", low, "to", hi, "in", versionPath);
      }
      await testTypesVersion(versionPath, low, hi, expectOnly, undefined, isLatest);
    }
  }

  if (!packageJson.nonNpm) {
    const attwJson = joinPaths(dtRoot, "attw.json");
    const failingPackages = readJson(attwJson).failingPackages;
    const dirName = dirPath.slice(dtRoot.length + "/types/".length);
    const expectError = failingPackages?.includes(dirName)
    const { output, status } = runAreTheTypesWrong(dirPath, attwJson);
    
    switch (expectError) {
      case true:
        switch (status) {
          case "error":
            // No need to bother anyone with a version mismatch error or non-failure error.
            return undefined;
          case "fail":
            // Show output without failing the build.
            return `Ignoring attw failure because "${dirName}" is listed in 'failingPackages'.\n\n@arethetypeswrong/cli\n${output}`;;
          case "pass":
            throw new Error(`attw passed: remove "${dirName}" from 'failingPackages' in attw.json\n\n${output}`);
          default:
            assertNever(status);
        }
      case false:
        switch (status) {
          case "error":
          case "fail":
            throw new Error(`!@arethetypeswrong/cli\n${output}`);
          case "pass":
            // Don't show anything for passing attw - most lint rules have no output on success.
            return undefined;
        }
      }
  }
  return undefined;
}

function maxVersion(v1: AllTypeScriptVersion, v2: TypeScriptVersion): TypeScriptVersion {
  // Note: For v1 to be later than v2, it must be a current Typescript version. So the type assertion is safe.
  return parseFloat(v1) >= parseFloat(v2) ? (v1 as TypeScriptVersion) : v2;
}

function next(v: TypeScriptVersion): TypeScriptVersion {
  const index = TypeScriptVersion.supported.indexOf(v);
  assert.notStrictEqual(index, -1);
  assert(index < TypeScriptVersion.supported.length);
  return TypeScriptVersion.supported[index + 1];
}

async function testTypesVersion(
  dirPath: string,
  lowVersion: TsVersion,
  hiVersion: TsVersion,
  expectOnly: boolean,
  tsLocal: string | undefined,
  isLatest: boolean
): Promise<void> {
  checkTslintJson(dirPath);
  const tsconfigErrors = checkTsconfig(dirPath, getCompilerOptions(dirPath));
  if (tsconfigErrors.length > 0) {
    throw new Error("\n\t* " + tsconfigErrors.join("\n\t* "));
  }
  const err = await lint(dirPath, lowVersion, hiVersion, isLatest, expectOnly, tsLocal);
  if (err) {
    throw new Error(err);
  }
}

function findDTRoot(dirPath: string) {
  let path = dirPath;
  while (basename(path) !== "types" && dirname(path) !== "." && dirname(path) !== "/") {
    path = dirname(path);
  }
  return dirname(path);
}

function assertPathIsInDefinitelyTyped(dirPath: string, dtRoot: string): void {
  // TODO: It's not clear whether this assertion makes sense, and it's broken on Azure Pipelines (perhaps because DT isn't cloned into DefinitelyTyped)
  // Re-enable it later if it makes sense.
  // if (basename(dtRoot) !== "DefinitelyTyped")) {
  if (!existsSync(joinPaths(dtRoot, "types"))) {
    throw new Error(
      "Since this type definition includes a header (a comment starting with `// Type definitions for`), " +
        "assumed this was a DefinitelyTyped package.\n" +
        "But it is not in a `DefinitelyTyped/types/xxx` directory: " +
        dirPath
    );
  }
}

/**
 * Starting at some point in time, npm has banned all new packages whose names
 * contain the word `download`. However, some older packages exist that still
 * contain this name.
 * @NOTE for contributors: The list of literal exceptions below should ONLY be
 * extended with packages for which there already exists a corresponding type
 * definition package in the `@types` scope. More information:
 * https://github.com/microsoft/DefinitelyTyped-tools/pull/381.
 */
function assertPathIsNotBanned(packageName: string) {
  if (
    /(^|\W)download($|\W)/.test(packageName) &&
    packageName !== "download" &&
    packageName !== "downloadjs" &&
    packageName !== "s3-download-stream"
  ) {
    // Since npm won't release their banned-words list, we'll have to manually add to this list.
    throw new Error(`${packageName}: Contains the word 'download', which is banned by npm.`);
  }
}

export function assertPackageIsNotDeprecated(packageName: string, notNeededPackages: string) {
  const unneeded = JSON.parse(notNeededPackages).packages;
  if (Object.keys(unneeded).includes(packageName)) {
    throw new Error(`${packageName}: notNeededPackages.json has an entry for ${packageName}.
That means ${packageName} ships its own types, and @types/${packageName} was deprecated and removed from Definitely Typed.
If you want to re-add @types/${packageName}, please remove its entry from notNeededPackages.json.`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack);
    process.exit(1);
  });
}
