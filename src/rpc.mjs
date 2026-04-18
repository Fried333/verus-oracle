const RPC_URL = process.env.VERUS_RPC_URL || "http://127.0.0.1:27486";
const RPC_USER = process.env.VERUS_RPC_USER || (() => {
  try {
    const conf = require("fs").readFileSync(require("os").homedir() + "/.verus/VRSC.conf", "utf8");
    return conf.match(/^rpcuser=(.+)/m)?.[1]?.trim();
  } catch { return "user"; }
})();
const RPC_PASS = process.env.VERUS_RPC_PASSWORD || (() => {
  try {
    const conf = require("fs").readFileSync(require("os").homedir() + "/.verus/VRSC.conf", "utf8");
    return conf.match(/^rpcpassword=(.+)/m)?.[1]?.trim();
  } catch { return "pass"; }
})();

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
    if (json.error) throw new Error(`RPC ${method} HTTP ${res.status}: ${JSON.stringify(json.error)}`);
    return json.result;
  }
}
