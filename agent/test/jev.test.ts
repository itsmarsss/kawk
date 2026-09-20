import { expect, test } from "bun:test";
import { Jev } from "../src/jev";
import { event } from "./helpers";
const answer = () => ({
  model: "jev-1.13.0",
  answers: {
    remember: { type: "noul", noul: 0.9 },
    act: { type: "noul", noul: 0.9 },
    route: {
      type: "choice",
      choice: "start",
      confidence: 0.1,
      probabilities: { observe: 0.03, start: 0.91, update: 0.03, cancel: 0.03 },
    },
  },
});
test("Jev uses the documented bank and selected probability, not entropy confidence", async () => {
  let request: any;
  const jev = new Jev({
    apiKey: "test-only",
    fetch: async (_url, init) => {
      request = JSON.parse(init!.body as string);
      return Response.json(answer());
    },
  });
  const d = await jev.decide(
    {
      event: { ...event("e", "Where are my keys?"), owner: "owner", receivedAt: 1000 },
      context: [],
      tasks: [],
    },
    new AbortController().signal,
  );
  expect(request.model).toBe("jev-1.13.0");
  expect(Object.keys(request.questions.route.criteria).sort()).toEqual([
    "cancel",
    "observe",
    "start",
    "update",
  ]);
  const snapshot = JSON.parse(request.state);
  expect(snapshot.LATEST_EVIDENCE.text).toBe("Where are my keys?");
  expect(snapshot.LATEST_EVIDENCE.provenance).toBeUndefined();
  expect(snapshot.LATEST_EVIDENCE.id).toBeUndefined();
  expect(snapshot.LATEST_EVIDENCE.speaker).toBe("unverified");
  expect(d.route).toBe("start");
  expect(d.confidence).toBe(0.91);
});
test("invalid Jev outputs do not become fabricated decisions", async () => {
  const bad = answer();
  bad.answers.route.probabilities.start = 9;
  const jev = new Jev({ apiKey: "test", fetch: async () => Response.json(bad) });
  expect(
    jev.decide(
      { event: { ...event("e", "hi"), owner: "owner", receivedAt: 0 }, context: [], tasks: [] },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});

test("Jev reviews delivery support independently of activation", async () => {
  let request: any;
  const jev = new Jev({
    apiKey: "test",
    fetch: async (_url, init) => {
      request = JSON.parse(init!.body as string);
      return Response.json({
        model: "jev-1.13.0",
        answers: {
          verdict: {
            type: "choice",
            choice: "unsupported",
            confidence: 0.8,
            probabilities: { supported: 0.2, unsupported: 0.8, uncertain: 0 },
          },
        },
      });
    },
  });
  expect(
    await jev.review(
      { goal: "where are keys?", text: "on the moon", evidence: [] },
      new AbortController().signal,
    ),
  ).toBe(false);
  expect(request.questions.verdict.type).toBe("choice");
});
