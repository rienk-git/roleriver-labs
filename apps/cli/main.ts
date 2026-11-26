import { readLocalText } from "./read-local.js";
import { OpenAIAssessmentProvider } from "../../packages/ai/openai.js";
import { run } from "./run.js";

const result = await run(process.argv.slice(2), {
  read: readLocalText,
  now: () => new Date(),
  provider: () => {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.ROLERIVER_OPENAI_MODEL;
    return apiKey?.trim() && model?.trim()
      ? new OpenAIAssessmentProvider({ apiKey, model })
      : undefined;
  },
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.code;
