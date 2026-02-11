"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendTelegram = sendTelegram;
function requireEnv(name) {
    const v = process.env[name];
    if (!v)
        throw new Error(`Missing env var: ${name}`);
    return v;
}
async function sendTelegram(text) {
    const botToken = requireEnv("TELEGRAM_BOT_TOKEN");
    const chatId = requireEnv("TELEGRAM_CHAT_ID");
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const payload = {
        chat_id: chatId,
        text,
        disable_web_page_preview: true
    };
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Telegram API error: ${res.status} ${errText}`);
    }
}
