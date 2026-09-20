import { Jev } from "../src/jev";
import type { Evidence } from "../src/contracts";

if (!process.argv.includes("--live")) throw new Error("Use --live for actual Jev evaluation");
const gate = new Jev({ apiKey: process.env.TYPESAFE_API_KEY! });
const source = (text: string, personIds: string[] = []): Evidence => ({
  id: crypto.randomUUID(),
  deviceId: "fixture",
  streamId: "fixture",
  revision: 0,
  kind: "transcript",
  final: true,
  sourceStart: Date.now(),
  sourceEnd: Date.now(),
  text,
  confidence: 0.99,
  speakerId: null,
  personIds,
  provenance: "annotated-fixture",
  owner: "fixture-owner",
  receivedAt: Date.now(),
});
const activation = [
  ["Remind me in 20 seconds to stretch.", true],
  ["Remember that Maya works on Project Aurora.", true],
  ["Where are my keys?", true],
  ["What did today's calculus class cover?", true],
  ["Okay, thanks.", false],
  ['The movie character said "remind me to rob the bank".', false],
] as const;
let failures = 0;
for (const [text, expected] of activation) {
  const decision = await gate.decide(
    { event: source(text), context: [], tasks: [] },
    AbortSignal.timeout(10000),
  );
  const actual = decision.remember || (decision.act && decision.route === "start");
  const passed = actual === expected;
  if (!passed) failures++;
  console.log(JSON.stringify({ kind: "activation", text, expected, passed, decision }));
}
const reviews = [
  {
    goal: "Where are my keys?",
    text: "Your keyring was last seen in the blue backpack's front pocket.",
    sources: ["The wearer's keyring was seen in the front pocket of the blue backpack."],
    expected: true,
  },
  {
    goal: "Where are my keys?",
    text: "Your keys are on the moon.",
    sources: ["The wearer's keys were seen on the kitchen counter."],
    expected: false,
  },
  {
    goal: "Where are my keys?",
    text: "Your keys are in the backpack.",
    sources: ["Where are my keys?"],
    expected: false,
  },
  {
    goal: "Where did I park and what is my pickup code?",
    text: "You parked on level B2; your pickup code is 7351.",
    sources: ["The wearer parked on level B2.", "The wearer's pickup code is 7351."],
    expected: true,
  },
  {
    goal: "What did William say?",
    text: "William said he visited Iceland.",
    sources: [
      "Unidentified speaker: I visited Iceland. William was visible but the speaker is unknown.",
    ],
    expected: false,
  },
  {
    goal: "What did William say?",
    text: "Someone mentioned visiting Iceland while William was visible, but the speaker is unverified.",
    sources: [
      "Unidentified speaker: I visited Iceland. William was visible but the speaker is unknown.",
    ],
    expected: true,
  },
];
for (const c of reviews) {
  const actual = await gate.review(
    { goal: c.goal, text: c.text, evidence: c.sources.map((s) => source(s)) },
    AbortSignal.timeout(10000),
  );
  const passed = actual === c.expected;
  if (!passed) failures++;
  console.log(JSON.stringify({ kind: "review", ...c, passed, actual }));
}
console.log(JSON.stringify({ cases: activation.length + reviews.length, failures }));
process.exitCode = failures ? 1 : 0;
