import assert from "node:assert/strict";
import {
  ACP_MSG_HISTORY_KEEP,
  ACP_MSG_HISTORY_SOFT,
  ACP_UPDATE_CHUNK_SOFT_CAP,
  capAcpText,
  trimAcpMsgHistory,
} from "./acp-hygiene.ts";

assert.equal(ACP_UPDATE_CHUNK_SOFT_CAP, 4096);
assert.equal(ACP_MSG_HISTORY_SOFT, 600);
assert.equal(ACP_MSG_HISTORY_KEEP, 400);

assert.equal(capAcpText("oi"), "oi");
assert.equal(capAcpText("abcdef", 3), "abc");
assert.equal(capAcpText(""), "");
assert.equal(capAcpText("😀😃😄", 2), "😀😃");

const short = [1, 2, 3];
assert.deepEqual(trimAcpMsgHistory(short, 10, 2), short);

const long = Array.from({ length: 650 }, (_, i) => i);
const trimmed = trimAcpMsgHistory(long);
assert.equal(trimmed.length, ACP_MSG_HISTORY_KEEP);
assert.equal(trimmed[0], 650 - ACP_MSG_HISTORY_KEEP);
assert.equal(trimmed[trimmed.length - 1], 649);

console.log("acp-hygiene: ok");
