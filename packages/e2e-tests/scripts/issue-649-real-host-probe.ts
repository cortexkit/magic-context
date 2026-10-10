import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PiTestHarness } from "../src/pi-harness";
import type { PiRunnerHost } from "../src/pi-runner/spawn";

interface ProbeCase {
  host: PiRunnerHost;
  version: string;
  label: string;
  loadOrder: string;
  extensionOrder?: "before" | "after";
  probeLoaded: boolean;
}

interface ProbeEvent {
  hasSections: boolean;
  probeValue: string | null;
}

const taskRootPath = process.env.TMPDIR;
const installRoot = process.env.ISSUE_649_HOST_INSTALL_ROOT;
if (!taskRootPath || !installRoot || !isAbsolute(taskRootPath) || !isAbsolute(installRoot)) {
  throw new Error("Set TMPDIR and ISSUE_649_HOST_INSTALL_ROOT to isolated absolute paths.");
}
if (!taskRootPath.endsWith(join("magic-context", "issue-649-post-merge"))) {
  throw new Error(`Host evidence root is not task-isolated: ${taskRootPath}`);
}
const taskRoot = realpathSync(taskRootPath);
mkdirSync(taskRoot, { recursive: true, mode: 0o700 });

const probeExtension = join(taskRoot, "probe-extension.mjs");
writeFileSync(
  probeExtension,
  `import { appendFileSync } from "node:fs";

export default function probeExtension(pi) {
  pi.on("before_agent_start", (event) => {
    const sections = event.systemPromptOptions?.sections;
    if (sections) sections.probe_ext = "<probe>";
    const record = {
      hasSections: Boolean(sections),
      probeValue: sections?.probe_ext ?? null,
    };
    appendFileSync(process.env.ISSUE_649_PROBE_EVENTS, JSON.stringify(record) + "\\n");
  });
}
`,
);

const packageJsonFor = (host: PiRunnerHost, version: string): string => {
  const packageName = host === "pi"
    ? "@earendil-works/pi-coding-agent"
    : "@oh-my-pi/pi-coding-agent";
  return join(installRoot, `${host}-${version}`, "node_modules", packageName, "package.json");
};

const cases: ProbeCase[] = [
  {
    host: "pi",
    version: "0.87.1",
    label: "pi-0.87.1-probe-before-magic-context",
    loadOrder: "probe extension before Magic Context",
    extensionOrder: "before",
    probeLoaded: true,
  },
  {
    host: "pi",
    version: "0.87.1",
    label: "pi-0.87.1-magic-context-before-probe",
    loadOrder: "Magic Context before probe extension",
    extensionOrder: "after",
    probeLoaded: true,
  },
  {
    host: "pi",
    version: "1.1.0",
    label: "pi-1.1.0-probe-before-magic-context",
    loadOrder: "probe extension before Magic Context",
    extensionOrder: "before",
    probeLoaded: true,
  },
  {
    host: "pi",
    version: "1.1.0",
    label: "pi-1.1.0-magic-context-before-probe",
    loadOrder: "Magic Context before probe extension",
    extensionOrder: "after",
    probeLoaded: true,
  },
  {
    host: "omp",
    version: "18.2.6",
    label: "omp-18.2.6-forced-prompt",
    loadOrder: "Magic Context only",
    probeLoaded: false,
  },
  {
    host: "omp",
    version: "18.8.7",
    label: "omp-18.8.7-forced-prompt",
    loadOrder: "Magic Context only",
    probeLoaded: false,
  },
  {
    host: "pi",
    version: "0.83.0",
    label: "pi-0.83.0-no-sections-control",
    loadOrder: "Magic Context before probe extension (no sections API)",
    extensionOrder: "after",
    probeLoaded: true,
  },
];

function excerptAround(value: string, marker: string): string | null {
  const index = value.indexOf(marker);
  if (index === -1) return null;
  return value.slice(Math.max(0, index - 100), index + marker.length + 140);
}

function lastUserMessageContains(
  request: { body: { messages?: Array<{ role?: string; content?: unknown }> } },
  needle: string,
): boolean {
  const lastUserMessage = [...(request.body.messages ?? [])]
    .reverse()
    .find((message) => message.role === "user");
  return JSON.stringify(lastUserMessage?.content ?? lastUserMessage).includes(needle);
}

function promptContentWithoutHostMetadata(host: PiRunnerHost, system: unknown): unknown {
  // OMP prepends a per-request billing header to system. Compare prompt content
  // separately; retain the full provider-field comparison below.
  if (host !== "omp" || !Array.isArray(system)) return system;
  return system.filter((part) => {
    if (typeof part !== "object" || part === null || !("text" in part)) return true;
    return !(typeof part.text === "string" && part.text.startsWith("x-anthropic-billing-header:"));
  });
}

function hostBillingHeader(system: unknown): string | null {
  if (!Array.isArray(system)) return null;
  const header = system.find((part) =>
    typeof part === "object" && part !== null && "text" in part &&
    typeof part.text === "string" && part.text.startsWith("x-anthropic-billing-header:")
  ) as { text: string } | undefined;
  return header?.text ?? null;
}

function readProbeEvents(path: string): ProbeEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProbeEvent);
}

function inspectThrowawayDatabaseFiles(hostPid: number, baseDir: string): string[] {
  const result = Bun.spawnSync(["lsof", "-p", String(hostPid)]);
  const output = result.stdout.toString();
  if (result.exitCode !== 0) {
    throw new Error(`lsof -p ${hostPid} failed: ${result.stderr.toString()}`);
  }
  const lsofPath = join(baseDir, "lsof.txt");
  writeFileSync(lsofPath, output);
  const dbPaths = output
    .split("\n")
    .map((line) => line.trim().split(/\s+/).slice(8).join(" "))
    .filter((path) => /\.db(?:-(?:wal|shm))?$/.test(path));
  const expectedRoot = `${resolve(baseDir)}${sep}`;
  const leakedPaths = dbPaths.filter((path) => !resolve(path).startsWith(expectedRoot));
  if (dbPaths.length === 0 || leakedPaths.length > 0) {
    throw new Error(
      `Host database isolation failed; throwaway DB paths=${JSON.stringify(dbPaths)}, outside=${JSON.stringify(leakedPaths)}. See ${lsofPath}`,
    );
  }
  writeFileSync(join(baseDir, "database-paths.json"), JSON.stringify(dbPaths, null, 2));
  return dbPaths;
}

const selectedCase = process.env.ISSUE_649_ONLY;
const selectedCases = selectedCase ? cases.filter((probeCase) => probeCase.label === selectedCase) : cases;
if (selectedCase && selectedCases.length === 0) throw new Error(`Unknown probe case: ${selectedCase}`);

const results: Array<Record<string, unknown>> = [];
for (const probeCase of selectedCases) {
  const packageJson = packageJsonFor(probeCase.host, probeCase.version);
  const manifest = JSON.parse(readFileSync(packageJson, "utf8")) as { version: string };
  if (manifest.version !== probeCase.version) {
    throw new Error(`${packageJson} reports ${manifest.version}, expected ${probeCase.version}`);
  }

  const probeEventsPath = join(taskRoot, `${probeCase.label}-events.jsonl`);
  writeFileSync(probeEventsPath, "");
  process.env.ISSUE_649_PROBE_EVENTS = probeEventsPath;
  if (probeCase.host === "pi") {
    process.env.MC_E2E_PI_PACKAGE_JSON = packageJson;
    delete process.env.MC_E2E_OMP_PACKAGE_JSON;
  } else {
    process.env.MC_E2E_OMP_PACKAGE_JSON = packageJson;
    delete process.env.MC_E2E_PI_PACKAGE_JSON;
  }

  const harness = await PiTestHarness.create({
    host: probeCase.host,
    magicContextConfig: { memory: { enabled: false } },
    ...(probeCase.probeLoaded
      ? probeCase.extensionOrder === "before"
        ? { extensionsBeforeMagicContext: [probeExtension] }
        : { extensionsAfterMagicContext: [probeExtension] }
      : {}),
  });
  const baseDir = dirname(harness.dataDir);
  try {
    const firstPrompt = `${probeCase.label}-turn-1`;
    const secondPrompt = `${probeCase.label}-turn-2`;
    await harness.sendPrompt(firstPrompt);
    await harness.sendPrompt(secondPrompt);
    await harness.waitForMockQuiescence({ quietMs: 250, label: probeCase.label });

    const requests = harness.requests();
    writeFileSync(join(baseDir, "all-captured-requests.json"), JSON.stringify(requests, null, 2));
    const firstRequests = requests.filter((request) => lastUserMessageContains(request, firstPrompt));
    const secondRequests = requests.filter((request) => lastUserMessageContains(request, secondPrompt));
    if (firstRequests.length !== 1 || secondRequests.length !== 1) {
      throw new Error(
        `${probeCase.label} expected one provider request per prompt; got ${firstRequests.length} and ${secondRequests.length}`,
      );
    }
    const turnRequests = [firstRequests[0]!, secondRequests[0]!];
    const bodiesPath = join(baseDir, "provider-bodies.json");
    writeFileSync(bodiesPath, JSON.stringify(turnRequests.map((request) => request.body), null, 2));
    const encodedProviderSystems = turnRequests.map((request) => JSON.stringify(request.body.system));
    if (encodedProviderSystems.some((encoded) => encoded === undefined)) {
      throw new Error(`${probeCase.label} provider request omitted its system prompt`);
    }
    const promptContents = turnRequests.map((request) =>
      promptContentWithoutHostMetadata(probeCase.host, request.body.system),
    );
    const encodedPrompts = promptContents.map((system) => JSON.stringify(system));
    const [firstSystem, secondSystem] = encodedPrompts as [string, string];
    const providerSystemFieldByteIdentical = Buffer.from(encodedProviderSystems[0]!).equals(
      Buffer.from(encodedProviderSystems[1]!),
    );
    const promptContentByteIdentical = Buffer.from(firstSystem).equals(Buffer.from(secondSystem));
    const hasMagicContext = encodedProviderSystems.map((system) => system!.includes("## Magic Context"));
    const hasProbe = encodedProviderSystems.map((system) => system!.includes("<probe>"));
    if (!hasMagicContext.every(Boolean) || !promptContentByteIdentical) {
      throw new Error(
        `${probeCase.label} lost Magic Context or changed prompt content: markers=${JSON.stringify(hasMagicContext)}, identical=${promptContentByteIdentical}, systems=${JSON.stringify(encodedPrompts.map((system) => system.slice(0, 1800)))}`,
      );
    }
    if (probeCase.probeLoaded && probeCase.version !== "0.83.0" && !hasProbe.every(Boolean)) {
      throw new Error(`${probeCase.label} did not deliver the probe section on both turns`);
    }
    if (probeCase.version === "0.83.0" && hasProbe.some(Boolean)) {
      throw new Error(`${probeCase.label} unexpectedly sent a probe section without host sections`);
    }

    const probeEvents = readProbeEvents(probeEventsPath);
    if (probeCase.probeLoaded && probeEvents.length === 0) {
      throw new Error(`${probeCase.label} probe extension did not run`);
    }
    if (probeCase.version === "0.83.0" && probeEvents.some((event) => event.hasSections)) {
      throw new Error(`${probeCase.label} unexpectedly exposed system-prompt sections`);
    }
    if (
      probeCase.probeLoaded && probeCase.version !== "0.83.0" &&
      probeEvents.some((event) => !event.hasSections || event.probeValue !== "<probe>")
    ) {
      throw new Error(`${probeCase.label} did not set probe_ext through the sections API`);
    }

    const hostPid = harness.hostPid;
    if (!hostPid) throw new Error(`${probeCase.label} has no host pid for the isolation check`);
    const databasePaths = inspectThrowawayDatabaseFiles(hostPid, baseDir);

    results.push({
      host: probeCase.host === "omp" ? "Oh My Pi" : "Pi",
      version: manifest.version,
      loadOrder: probeCase.loadOrder,
      magicContextBlockPresentOnBothTurns: hasMagicContext.every(Boolean),
      probeSectionPresentOnBothTurns: probeCase.probeLoaded && probeCase.version !== "0.83.0"
        ? hasProbe.every(Boolean)
        : probeCase.version === "0.83.0"
          ? false
          : null,
      secondTurnPromptContentByteIdentical: promptContentByteIdentical,
      providerSystemFieldByteIdentical,
      providerSystemFieldBillingHeaders: turnRequests.map((request) => hostBillingHeader(request.body.system)),
      systemPromptContentBytes: Buffer.byteLength(firstSystem),
      systemPromptContentSha256: createHash("sha256").update(firstSystem).digest("hex"),
      magicContextExcerpt: excerptAround(firstSystem, "## Magic Context"),
      probeExcerpt: excerptAround(firstSystem, "<probe>"),
      probeEvents,
      hostPid,
      evidenceDirectory: relative(taskRoot, baseDir),
      lsofDatabasePaths: databasePaths.map((path) => relative(baseDir, path)),
      providerBodies: relative(baseDir, bodiesPath),
      allCapturedRequests: "all-captured-requests.json",
      extensionErrors: [],
    });
  } finally {
    await harness.dispose();
  }
}

const resultPath = join(taskRoot, "results.json");
writeFileSync(resultPath, JSON.stringify(results, null, 2));
console.log(JSON.stringify({ evidenceRoot: taskRoot, resultPath, results }, null, 2));
