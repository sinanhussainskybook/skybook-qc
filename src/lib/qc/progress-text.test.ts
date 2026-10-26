import { describe, expect, it } from "vitest";
import { expectedTime, progressLine } from "@/lib/qc/progress-text";

/** What the designer reads while a check runs: the step it's on, by name, and how long to expect. */
describe("progress wording", () => {
  const run = (over: Partial<Parameters<typeof progressLine>[0]>) => ({ status: "processing", stage: "Reading text", done: 1, total: 4, ...over });

  it("names the step it's on: 'Step 2 of 4: Reading text'", () => {
    expect(progressLine(run({}), "Checking the design")).toBe("Step 2 of 4: Reading text");
    expect(progressLine(run({ stage: "Checking the design", done: 0, total: 1 }), "Checking the design")).toBe("Step 1 of 1: Checking the design");
  });

  it("before the steps and after them: waiting, preparing the files, preparing the result", () => {
    expect(progressLine(run({ status: "queued", stage: null, done: 0, total: 0 }), "Checking the design")).toBe("Waiting to start");
    expect(progressLine(run({ stage: "Starting", done: 0, total: 1 }), "Checking the design")).toBe("Preparing the files");
    expect(progressLine(run({ stage: "Preparing files", done: 0, total: 0 }), "Checking the design")).toBe("Preparing the files");
    expect(progressLine(run({ done: 4, total: 4 }), "Checking the design")).toBe("Preparing the result");
  });

  it("a realistic time: under a minute for a design, seconds for a brief, minutes for local AI", () => {
    expect(expectedTime("content", "gemini")).toBe("Usually under a minute.");
    expect(expectedTime("information", "gemini")).toBe("Usually a few seconds.");
    expect(expectedTime("content", "local")).toBe("Local AI can take several minutes per design.");
    expect(expectedTime("content", "mock")).toBe("Sample data: a few seconds.");
  });
});
