const { Expo } = require("expo-server-sdk");

// Create a new Expo SDK client
const expo = new Expo();

/**
 * Send a push notification to a single device token.
 * @param {string} expoPushToken
 * @param {string} title
 * @param {string} body
 * @param {object} data - Optional data payload
 */
async function sendPushToToken(expoPushToken, title, body, data = {}) {
    try {
        if (!Expo.isExpoPushToken(expoPushToken)) {
            console.warn("Invalid Expo push token:", expoPushToken);
            return { ok: false, error: "InvalidExpoPushToken" };
        }

        const messages = [
            {
                to: expoPushToken,
                sound: "default",
                title,
                body,
                data,
            },
        ];

        // Expo handles chunking even for single messages (good practice)
        const chunks = expo.chunkPushNotifications(messages);
        const tickets = [];

        for (const chunk of chunks) {
            try {
                const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
                tickets.push(...ticketChunk);
            } catch (error) {
                console.error("Error sending push chunk:", error);
                return { ok: false, error: "SendChunkError" };
            }
        }

        // Check if the specific ticket contains an error
        if (tickets[0] && tickets[0].status === "error") {
            console.error("Expo Ticket Error:", tickets[0]);
            return { ok: false, error: tickets[0].details?.error || "UnknownTicketError" };
        }

        return { ok: true, tickets };
    } catch (err) {
        console.error("sendPushToToken error:", err);
        return { ok: false, error: "ServerError" };
    }
}

/**
 * Send push notifications to multiple tokens efficiently.
 * Handles chunking and identifies invalid tokens from the immediate server response.
 *
 * @param {string[]} tokens - Array of Expo Push Tokens
 * @param {string} title
 * @param {string} body
 * @param {object} data
 * @returns {Promise<{successCount: number, failCount: number, invalidTokens: string[]}>}
 */
async function sendPushToManyTokens(tokens, title, body, data = {}) {
    // 1. Clean and Deduplicate Tokens
    const uniqueTokens = Array.from(
        new Set(tokens.filter((t) => typeof t === "string" && t.trim().length > 0))
    );

    // 2. Separate format-invalid tokens immediately
    const invalidTokens = [];
    const validTokens = [];

    for (const t of uniqueTokens) {
        if (!Expo.isExpoPushToken(t)) {
            invalidTokens.push(t);
        } else {
            validTokens.push(t);
        }
    }

    if (validTokens.length === 0) {
        return {
            successCount: 0,
            failCount: 0,
            invalidTokens, // Returns tokens that failed regex validation
        };
    }

    // 3. Construct Messages
    // We keep the 'messages' array flat to map tickets back to tokens later
    const messages = validTokens.map((to) => ({
        to,
        sound: "default",
        title,
        body,
        data,
    }));

    // 4. Send in Chunks
    const chunks = expo.chunkPushNotifications(messages);
    const tickets = [];
    let sendErrors = 0;

    for (const chunk of chunks) {
        try {
            const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
            tickets.push(...ticketChunk);
        } catch (e) {
            console.error("expo.sendPushNotificationsAsync error:", e);
            sendErrors += chunk.length; // Count all messages in chunk as failed
        }
    }

    // 5. Analyze Tickets to find Invalid Tokens
    // The 'tickets' array corresponds 1-to-1 with the 'messages' array (if no chunks failed completely)
    // NOTE: If a whole chunk failed (exception caught above), tickets array might be shorter than messages.
    // We align them carefully.

    let successCount = 0;
    let failCount = sendErrors;

    // We iterate up to the number of tickets received
    for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        const originalToken = messages[i].to; // Mapping back to the token

        if (ticket.status === "ok") {
            successCount++;
        } else {
            // Status is 'error'
            failCount++;

            // If the error indicates the device is no longer valid, add to invalid list
            if (ticket.details && ticket.details.error === "DeviceNotRegistered") {
                invalidTokens.push(originalToken);
            }
        }
    }

    /**
     * NOTE regarding Receipts:
     * We do NOT fetch receipts here (getPushNotificationReceiptsAsync).
     * Receipts are asynchronous and may take minutes to generate.
     * Fetching them immediately often yields nothing.
     * For a robust system, a separate background job (Cron) should check receipts.
     */

    return {
        successCount,
        failCount,
        invalidTokens, // Contains both regex-fail and DeviceNotRegistered tokens
    };
}

module.exports = {
    sendPushToToken,
    sendPushToManyTokens,
};