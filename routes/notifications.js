const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

// Internal Imports
const { NotificationModel } = require("../models/notificationModel");
const { UserModel } = require("../models/userModel");
const { auth } = require("../auth/auth");

// Helper
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

/* ======================================================
   🔔 GET LATEST NOTIFICATIONS
   Returns the last 5 notifications + hasUnread status
   GET /notifications/latest
====================================================== */
router.get("/latest", auth, async (req, res) => {
    try {
        const { business, _id: userId } = req.tokenData;

        if (!isValidObjectId(business) || !isValidObjectId(userId)) {
            return res.status(400).json({ error: "Invalid token data" });
        }

        // Fetch notifications and user data in parallel for performance
        const [notifications, user] = await Promise.all([
            NotificationModel.find({ business })
                .sort({ createdAt: -1 })
                .limit(5)
                .lean(),
            UserModel.findOne({ _id: userId, business })
                .select("lastSeenNotificationsAt")
                .lean(),
        ]);

        const latestCreatedAt = notifications?.[0]?.createdAt || null;
        const lastSeen = user?.lastSeenNotificationsAt || null;

        // Logic: If the newest notification is newer than the user's "last seen" timestamp -> Unread exists.
        const hasUnread = Boolean(
            latestCreatedAt && (!lastSeen || new Date(latestCreatedAt) > new Date(lastSeen))
        );

        res.json({
            notifications,
            hasUnread,
            latestCreatedAt,
            lastSeenNotificationsAt: lastSeen,
        });
    } catch (err) {
        console.error("GET /notifications/latest error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/* ======================================================
   👁 MARK SEEN
   Updates the user's timestamp to now.
   POST /notifications/mark-seen
====================================================== */
router.post("/mark-seen", auth, async (req, res) => {
    try {
        const { business, _id: userId } = req.tokenData;

        if (!isValidObjectId(business) || !isValidObjectId(userId)) {
            return res.status(400).json({ error: "Invalid token data" });
        }

        // Update the timestamp to current time
        await UserModel.updateOne(
            { _id: userId, business },
            { $set: { lastSeenNotificationsAt: new Date() } }
        );

        res.json({ ok: true });
    } catch (err) {
        console.error("POST /notifications/mark-seen error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

module.exports = router;