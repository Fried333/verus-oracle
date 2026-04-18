import { readFileSync } from "fs";
import { homedir } from "os";

function loadConf() {
  try {
    const paths = [homedir() + "/.komodo/VRSC/VRSC.conf", homedir() + "/.verus/VRSC.conf"];
    for (const p of paths) { try { return readFileSync(p, "utf8"); } catch {} }
    return "";
  } catch { return ""; }
}

const conf = loadConf();
const RPC_URL = process.env.VERUS_RPC_URL || "http://127.0.0.1:27486";
const RPC_USER = process.env.VERUS_RPC_USER || conf.match(/^rpcuser=(.+)/m)?.[1]?.trim() || "user";
const RPC_PASS = process.env.VERUS_RPC_PASSWORD || conf.match(/^rpcpassword=(.+)/m)?.[1]?.trim() || "pass";

export class VerusRpc {
  async call(method, params = []) {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString("base64"),
      },
      body: JSON.stringify({ jsonrpc: "1.0", id: "oracle", method, params }),
    });
    const json = await res.json();
    if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`);
    return json.result;
  }
}
