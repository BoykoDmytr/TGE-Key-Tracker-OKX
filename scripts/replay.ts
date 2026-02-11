import { readFileSync } from "fs";
import { createHmac } from "crypto";
import http from "http";
import https from "https";
import { URL } from "url";

const secret = process.env.MORALIS_WEBHOOK_SECRET || "testsecret";
const payloadFile = process.env.PAYLOAD_FILE || "./sample_payload.json";
const webhookUrl = process.env.WEBHOOK_URL || "http://localhost:3000/webhooks/moralis";
const signatureHeader = process.env.MORALIS_SIGNATURE_HEADER || "x-signature";

const body = readFileSync(payloadFile, "utf8");
const sig = createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex");

const u = new URL(webhookUrl);
const isHttps = u.protocol === "https:";

const req = (isHttps ? https : http).request(
  {
    method: "POST",
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + u.search,
    headers: {
      "content-type": "application/json",
      [signatureHeader]: sig
    }
  },
  (res) => {
    let data = "";
    res.on("data", (c) => (data += c));
    res.on("end", () => {
      console.log("Status:", res.statusCode);
      console.log("Body:", data);
    });
  }
);

req.on("error", (e) => console.error(e));
req.write(body);
req.end();
