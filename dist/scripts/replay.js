"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const crypto_1 = require("crypto");
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
const url_1 = require("url");
const secret = process.env.MORALIS_WEBHOOK_SECRET || "testsecret";
const payloadFile = process.env.PAYLOAD_FILE || "./sample_payload.json";
const webhookUrl = process.env.WEBHOOK_URL || "http://localhost:3000/webhooks/moralis";
const signatureHeader = process.env.MORALIS_SIGNATURE_HEADER || "x-signature";
const body = (0, fs_1.readFileSync)(payloadFile, "utf8");
const sig = (0, crypto_1.createHmac)("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex");
const u = new url_1.URL(webhookUrl);
const isHttps = u.protocol === "https:";
const req = (isHttps ? https_1.default : http_1.default).request({
    method: "POST",
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + u.search,
    headers: {
        "content-type": "application/json",
        [signatureHeader]: sig
    }
}, (res) => {
    let data = "";
    res.on("data", (c) => (data += c));
    res.on("end", () => {
        console.log("Status:", res.statusCode);
        console.log("Body:", data);
    });
});
req.on("error", (e) => console.error(e));
req.write(body);
req.end();
