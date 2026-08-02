import assert from "node:assert/strict";
import test from "node:test";
import {
  maskedRecoveryAddress,
  recoveryAddressFor,
  RecoveryDirectoryError,
} from "./recovery-directory.ts";

test("directory resolves a normalized portal account to an external owner address", () => {
  assert.equal(
    recoveryAddressFor(
      JSON.stringify({ "Member@WiserChat.ai": "Owner@Personal.Example" }),
      "member@wiserchat.ai",
      "wiserchat.ai,test.wiserchat.ai",
    ),
    "owner@personal.example",
  );
});

test("directory default resolves and masks any valid portal account", () => {
  const address = recoveryAddressFor(
    JSON.stringify({ "*": "Hesham@Gmail.com" }),
    "future.member@wiserchat.ai",
    "wiserchat.ai,test.wiserchat.ai",
  );

  assert.equal(address, "hesham@gmail.com");
  assert.equal(maskedRecoveryAddress(address), "h•••@g•••.com");
});

test("directory exact entry overrides the default", () => {
  assert.equal(
    recoveryAddressFor(
      JSON.stringify({
        "*": "default@example.com",
        "Member@WiserChat.ai": "specific@example.com",
      }),
      "member@wiserchat.ai",
      "wiserchat.ai,test.wiserchat.ai",
    ),
    "specific@example.com",
  );
});

test("directory rejects invalid default destinations as invalid config", () => {
  for (const directory of [
    JSON.stringify({ "*": "owner@test.wiserchat.ai" }),
    JSON.stringify({ "*": "not-an-address" }),
    JSON.stringify({ "*": "" }),
    JSON.stringify({ "*": 42 }),
  ]) {
    assert.throws(
      () =>
        recoveryAddressFor(
          directory,
          "member@wiserchat.ai",
          "wiserchat.ai,test.wiserchat.ai",
        ),
      (error: unknown) =>
        error instanceof RecoveryDirectoryError &&
        error.code === "INVALID_CONFIG",
    );
  }
});

test("directory without an exact or default entry remains unmapped", () => {
  assert.throws(
    () =>
      recoveryAddressFor(
        JSON.stringify({ "other@wiserchat.ai": "owner@example.com" }),
        "member@wiserchat.ai",
        "wiserchat.ai,test.wiserchat.ai",
      ),
    (error: unknown) =>
      error instanceof RecoveryDirectoryError && error.code === "UNMAPPED",
  );
});

test("directory fails closed for missing, malformed, internal, or ambiguous entries", () => {
  for (const [directory, portal] of [
    [undefined, "member@wiserchat.ai"],
    ["not json", "member@wiserchat.ai"],
    [
      JSON.stringify({ "other@wiserchat.ai": "owner@personal.example" }),
      "member@wiserchat.ai",
    ],
    [
      JSON.stringify({ "member@wiserchat.ai": "owner@test.wiserchat.ai" }),
      "member@wiserchat.ai",
    ],
    [
      JSON.stringify({
        "MEMBER@wiserchat.ai": "one@example.com",
        "member@wiserchat.ai": "two@example.com",
      }),
      "member@wiserchat.ai",
    ],
  ] as const) {
    assert.throws(
      () =>
        recoveryAddressFor(directory, portal, "wiserchat.ai,test.wiserchat.ai"),
      RecoveryDirectoryError,
    );
  }
});
