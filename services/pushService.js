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
            // מחזירים תוצאה מסודרת כדי שהקוד שקורא ידע שזה נכשל
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

        return { ok: true, tickets };
    } catch (err) {
        console.error("sendPushToToken error:", err);
        return { ok: false, error: "ServerError" };
    }
}

/**
 * שולח פוש להרבה מכשירים (tokens) בצורה יעילה + מחזיר סטטיסטיקות.
 * מומלץ לשימוש ב-"broadcast" כמו אדמין שולח לכל העסק.
 *
 * @param {string[]} tokens
 * @param {string} title
 * @param {string} body
 * @param {object} data
 * @returns { successCount, failCount, invalidTokens, ticketCount, receiptErrorCount }
 */
async function sendPushToManyTokens(tokens, title, body, data = {}) {
    // 1) ניקוי tokens: רק strings לא ריקים + dedupe
    const uniqueTokens = Array.from(
        new Set(tokens.filter((t) => typeof t === "string" && t.trim().length > 0))
    );

    // 2) הפרדה בין tokens “ממש לא תקינים” לבין תקינים
    const invalidTokens = [];
    const validTokens = [];

    for (const t of uniqueTokens) {
        if (!Expo.isExpoPushToken(t)) invalidTokens.push(t);
        else validTokens.push(t);
    }

    if (validTokens.length === 0) {
        return {
            successCount: 0,
            failCount: 0,
            invalidTokens,
            ticketCount: 0,
            receiptErrorCount: 0,
        };
    }

    // 3) בניית messages לכל הטוקנים
    const messages = validTokens.map((to) => ({
        to,
        sound: "default",
        title,
        body,
        data,
    }));

    // 4) שליחה בצ'אנקים לפי Expo
    const chunks = expo.chunkPushNotifications(messages);

    const tickets = []; // כל טיקט מתאים להודעה שיצאה
    let sendErrors = 0;

    for (const chunk of chunks) {
        try {
            const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
            tickets.push(...ticketChunk);
        } catch (e) {
            sendErrors += 1;
            console.error("expo.sendPushNotificationsAsync error:", e);
        }
    }

    // 5) ניתוח tickets: success/fail מיידי (לפעמים השגיאה כבר כאן)
    // בנוסף, אוספים receiptIds כדי למשוך receipts.
    const receiptIds = [];
    let immediateFailCount = 0;
    let immediateSuccessCount = 0;

    for (const ticket of tickets) {
        if (!ticket) continue;

        if (ticket.status === "ok") {
            immediateSuccessCount += 1;
            if (ticket.id) receiptIds.push(ticket.id);
        } else {
            // status === "error"
            immediateFailCount += 1;

            // לפעמים כאן כבר נקבל DeviceNotRegistered וכו'
            const details = ticket.details || {};
            const errCode = details.error;

            if (errCode === "DeviceNotRegistered") {
                // לא תמיד יש פה token – Expo לא מחזיר token בתוך ticket,
                // לכן את ניקוי ה-token עדיף לעשות על בסיס receipts (שלב 6).
            }
        }
    }

    // 6) משיכת receipts: מאפשר לזהות DeviceNotRegistered בצורה אמינה יותר
    let receiptErrorCount = 0;
    let receiptDeviceNotRegisteredCount = 0;

    if (receiptIds.length > 0) {
        const receiptIdChunks = expo.chunkPushNotificationReceiptIds(receiptIds);

        for (const chunk of receiptIdChunks) {
            try {
                const receipts = await expo.getPushNotificationReceiptsAsync(chunk);

                for (const receiptId of Object.keys(receipts)) {
                    const receipt = receipts[receiptId];
                    if (!receipt) continue;

                    if (receipt.status === "error") {
                        receiptErrorCount += 1;

                        const details = receipt.details || {};
                        const errCode = details.error;

                        if (errCode === "DeviceNotRegistered") {
                            receiptDeviceNotRegisteredCount += 1;
                            // שוב: receipts לא מחזירים token ישירות.
                            // לכן אם אתה רוצה "ניקוי טוקנים" מדויק 1:1,
                            // צריך לשמור mapping של message->ticketId->token.
                            // (מוסבר בהערה למטה)
                        }
                    }
                }
            } catch (e) {
                console.error("expo.getPushNotificationReceiptsAsync error:", e);
            }
        }
    }

    // 7) סיכום
    // שים לב: "successCount" כאן הוא בעיקר על בסיס tickets 'ok' (כלומר, נמסר ל-Expo).
    // הצלחה אמיתית למכשיר תלויה ב-receipts, אבל Expo לא תמיד נותן מיפוי קל לטוקן.
    const successCount = immediateSuccessCount;
    const failCount = immediateFailCount + sendErrors;

    return {
        successCount,
        failCount,
        invalidTokens,
        ticketCount: tickets.length,
        receiptErrorCount,
        receiptDeviceNotRegisteredCount,
    };
}

module.exports = {
    sendPushToToken,
    sendPushToManyTokens,
};
