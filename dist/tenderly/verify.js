import crypto from 'crypto';
/**
 * Verify Tenderly webhook HMAC signature.
 * Tenderly signs the raw body + date with your signing key using sha256.
 */
export function verifyTenderlySignature(params) {
    const { signingKey, signature, date, rawBody } = params;
    if (!signature || !date)
        return false;
    const hmac = crypto.createHmac('sha256', signingKey);
    hmac.update(rawBody.toString('utf8'), 'utf8');
    hmac.update(date);
    const digest = hmac.digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
    }
    catch {
        return false;
    }
}
