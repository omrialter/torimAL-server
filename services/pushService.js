// services/pushService.js
const { Expo } = require("expo-server-sdk");

// יוצרים מופע יחיד של Expo SDK
const expo = new Expo();

/**
 * שולח פוש למכשיר אחד (לפי expoPushToken)
 * @param {string} expoPushToken
 * @param {string} title
 * @param {string} body
 * @param {object} data  - אובייקט אופציונלי (למתן מידע נוסף לקליינט)
 */
async function sendPushToToken(expoPushToken, title, body, data = {}) {
    try {
        if (!Expo.isExpoPushToken(expoPushToken)) {
            console.warn("Invalid Expo push token:", expoPushToken);
            return;
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

        const chunks = expo.chunkPushNotifications(messages);
        const tickets = [];

        for (const chunk of chunks) {
            try {
                const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
                tickets.push(...ticketChunk);
            } catch (error) {
                console.error("Error sending push chunk:", error);
            }
        }

        return tickets;
    } catch (err) {
        console.error("sendPushToToken error:", err);
    }
}

module.exports = {
    sendPushToToken,
};
