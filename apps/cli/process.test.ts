import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const entry = resolve("dist/apps/cli/main.js");
const runModule = pathToFileURL(resolve("dist/apps/cli/run.js")).href;
const safeEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "roleriver-cli-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("built CLI process", () => {
  it("blocks unconsented requests without leaking arguments or reading credentials", () => {
    const dir = tempDir();
    const cv = join(dir, "cv.txt");
    const vacancy = join(dir, "vacancy.txt");
    writeFileSync(cv, "Synthetic CV");
    writeFileSync(vacancy, "Synthetic role");
    const result = spawnSync(
      process.execPath,
      [entry, "assess", "--cv", cv, "--vacancy", vacancy],
      { encoding: "utf8", env: safeEnv },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--confirm-manual");
    expect(result.stderr).not.toContain("Synthetic CV");
    expect(result.stderr).not.toContain(cv);
  });
  it("rejects an oversized input without leaking its contents or path", () => {
    const dir = tempDir();
    const cv = join(dir, "cv.txt");
    const vacancy = join(dir, "vacancy.txt");
    writeFileSync(cv, "x".repeat(1024 * 1024 + 1));
    writeFileSync(vacancy, "Synthetic role");
    const result = spawnSync(
      process.execPath,
      [entry, "assess", "--cv", cv, "--vacancy", vacancy],
      { encoding: "utf8", env: safeEnv },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Unable to read or parse input files.\n");
    expect(result.stderr).not.toContain(cv);
  });
  it("short-circuits confirmed expiry without credentials or network", () => {
    const dir = tempDir();
    const cv = join(dir, "cv.txt");
    const vacancy = join(dir, "vacancy.txt");
    const details = join(dir, "details.json");
    writeFileSync(cv, "Synthetic CV");
    writeFileSync(vacancy, "Synthetic role");
    writeFileSync(
      details,
      JSON.stringify({
        vacancyMetadata: {
          deadline: {
            kind: "instant",
            value: "2000-01-01T00:00:00Z",
            verified: false,
          },
        },
      }),
    );
    const output = execFileSync(
      process.execPath,
      [
        entry,
        "assess",
        "--cv",
        cv,
        "--vacancy",
        vacancy,
        "--details",
        details,
        "--confirm-deadline",
        "--format",
        "json",
      ],
      { encoding: "utf8", env: safeEnv },
    );
    expect(JSON.parse(output)).toMatchObject({
      disposition: "unsuitable",
      reviewRequired: false,
      reason: "confirmed_expired_deadline",
    });
  });
  it("runs the production entrypoint with an intercepted offline transport", () => {
    const dir = tempDir();
    const cv = join(dir, "cv.txt");
    const vacancy = join(dir, "vacancy.txt");
    const preload = join(dir, "mock-fetch.mjs");
    writeFileSync(cv, "Synthetic CV");
    writeFileSync(vacancy, "Synthetic job");
    writeFileSync(
      preload,
      `globalThis.fetch = async () => new Response(JSON.stringify({status:"completed", output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({recommendation:"review",roleAlignment:{status:"unclear",explanation:"Role unclear",vacancyEvidence:[],candidateEvidence:[]},matchScore:null,confidence:"medium",vacancyCompleteness:"unknown",requirements:[],disqualifiers:[],strengths:[],gaps:[],warnings:[],summary:"Review"})}]}]}));`,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        preload,
        entry,
        "assess",
        "--cv",
        cv,
        "--vacancy",
        vacancy,
        "--live",
        "--confirm-manual",
        "--confirm-minimized",
        "--format",
        "json",
      ],
      {
        encoding: "utf8",
        env: {
          ...safeEnv,
          OPENAI_API_KEY: "synthetic-key",
          ROLERIVER_OPENAI_MODEL: "synthetic-model",
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      disposition: null,
      reviewRequired: true,
      assessment: { recommendation: "review" },
      provenance: { model: "synthetic-model" },
    });
    expect(result.stdout).not.toContain("synthetic-key");
  });
  it("runs the built assessment path in a subprocess with an injected offline mock", () => {
    const script = `import { run } from ${JSON.stringify(runModule)};
const a={recommendation:"review",roleAlignment:{status:"unclear",explanation:"Role unclear",vacancyEvidence:[],candidateEvidence:[]},matchScore:null,confidence:"medium",vacancyCompleteness:"unknown",requirements:[],disqualifiers:[],strengths:[],gaps:[],warnings:[],summary:"Review"};
const p={model:"test",promptVersion:"p",schemaVersion:"s",candidateHash:"c",vacancyHash:"v",preferencesHash:"p",assessedAt:"2026-01-01T00:00:00Z"};
const result=await run(["assess","--cv","cv","--vacancy","job","--live","--confirm-manual","--confirm-minimized","--format","json"],{read:async p=>p==="cv"?"Synthetic CV":"Synthetic job",now:()=>new Date(),provider:()=>({assess:async()=>({ok:true,assessment:a,provenance:p})})});
process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode=result.code;`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { encoding: "utf8", env: safeEnv },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      disposition: null,
      reviewRequired: true,
      assessment: { recommendation: "review" },
    });
  });
});
