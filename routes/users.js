const express = require("express");
const mongoose = require("mongoose");
const crypto = require("crypto");
const Joi = require("joi");
const router = express.Router();

// Internal Imports
const { UserModel, createToken } = require("../models/userModel");
const { NotificationModel } = require("../models/notificationModel");
const admin = require("../services/firebase.js");
const { auth, authAdmin } = require("../auth/auth.js");
const { toE164IL } = require("../services/utils_phone.js");
const { sendPushToToken, sendPushToManyTokens } = require("../services/pushService");

// ---------------------------------------------------------
// Validation Schemas & Helpers
// ---------------------------------------------------------

const pushSchema = Joi.object({
    title: Joi.string().trim().min(1).max(80).required(),
    body: Joi.string().trim().min(1).max(180).required(),
    data: Joi.object().unknown(true).default({}),
});

/**
 * Checks if a string is a valid MongoDB ObjectId
 */
const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

/**
 * Helper: Notify all admins of a business about specific events.
 * Filters admins based on their specific notification preferences.
 */
async function notifyAdmins(businessId, eventType, title, body, data = {}) {
    try {
        const settingKeyByEvent = {
            appointment_created: "onAppointmentCreated",
            appointment_canceled: "onAppointmentCanceled",
            user_signup: "onUserSignup",
        };

        const settingKey = settingKeyByEvent[eventType];
        if (!settingKey) return { ok: false, error: "Unknown eventType" };

        // Find admins who have push enabled globally
        const admins = await UserModel.find({
            business: businessId,
            role: "admin",
            expoPushToken: { $exists: true, $ne: null },
            "adminPushSettings.enabled": { $ne: false },
        }).select("expoPushToken adminPushSettings");

        // Filter tokens based on the specific event setting
        const tokens = admins
            .filter((admin) => admin.adminPushSettings?.[settingKey] !== false) // Check specific setting
            .map((admin) => admin.expoPushToken)
            .filter((t) => typeof t === "string" && t.trim().length > 0) // Validate token string
            .map((t) => t.trim()); // Clean whitespace

        // Remove duplicates
        const uniqueTokens = [...new Set(tokens)];

        if (uniqueTokens.length === 0) return { ok: true, sent: 0 };

        return await sendPushToManyTokens(uniqueTokens, title, body, {
            ...data,
            type: "admin_event",
            eventType,
            businessId: String(businessId),
            createdAt: new Date().toISOString(),
        });
    } catch (err) {
        console.error("notifyAdmins error:", err);
        return { ok: false };
    }
}

// ---------------------------------------------------------
// Routes
// ---------------------------------------------------------

/**
 * GET /checkToken
 * valid user token check
 */
router.get("/checkToken", auth, async (req, res) => {
    res.json({ _id: req.tokenData._id, role: req.tokenData.role });
});

/**
 * GET /userInfo
 * Returns current user profile
 */
router.get("/userInfo", auth, async (req, res) => {
    try {
        // 🛡️ Security: Ensure user belongs to the token's business
        const user = await UserModel.findOne({
            _id: req.tokenData._id,
            business: req.tokenData.business,
        }).lean();

        if (!user) return res.sendStatus(401); // User might have been deleted

        res.json(user);
    } catch (err) {
        console.error("userInfo error:", err);
        res.status(502).json({ error: "Server error" });
    }
});

/**
 * POST /signup
 * Creates a new user (Phone verification via Firebase)
 */
router.post("/signup", async (req, res) => {
    const { idToken, name, businessId } = req.body;

    if (!idToken || !name || !businessId) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    if (!isValidId(businessId)) {
        return res.status(400).json({ error: "Invalid business ID format" });
    }

    try {
        // Verify Firebase Token
        const decoded = await admin.auth().verifyIdToken(idToken);
        let phone = decoded.phone_number;
        if (!phone) return res.status(400).json({ error: "Invalid phone number in token" });

        phone = toE164IL(phone);

        // Check if user exists in THIS business
        const existing = await UserModel.findOne({ phone, business: businessId });
        if (existing) return res.status(400).json({ error: "User already exists" });

        // Create User
        const newUser = await UserModel.create({
            name,
            phone,
            business: businessId,
            role: "user",
        });

        // Notify Admins (Async - Fire & Forget)
        notifyAdmins(
            businessId,
            "user_signup",
            "New User Signup",
            `${name} has joined the system`,
            { userId: String(newUser._id) }
        ).catch((err) => console.error("Signup push failed:", err));

        // Generate JWT
        const token = createToken(newUser._id, newUser.role, businessId);
        return res.json({ token, user: newUser });
    } catch (err) {
        console.error("Signup error:", err);
        if (err.code && err.code.startsWith("auth/")) {
            return res.status(401).json({ error: "Invalid Firebase ID token" });
        }
        return res.status(500).json({ error: "Server error during signup" });
    }
});

/**
 * POST /check-phone
 * Checks if a phone number is already registered in a business
 */
router.post("/check-phone", async (req, res) => {
    let { phone, businessId } = req.body;

    if (!phone || !businessId) {
        return res.status(400).json({ error: "Phone and businessId are required" });
    }

    if (!isValidId(businessId)) {
        return res.status(400).json({ error: "Invalid business ID format" });
    }

    phone = toE164IL(phone);

    try {
        const user = await UserModel.findOne({ phone, business: businessId }).select("_id");
        if (!user) return res.status(404).json({ error: "User not found" });

        return res.json({ ok: true });
    } catch (err) {
        console.error("check-phone error:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/**
 * POST /verify
 * Login: Verifies Firebase Token -> Returns App JWT
 */
router.post("/verify", async (req, res) => {
    try {
        const { idToken, businessId } = req.body;

        if (!idToken || !businessId) {
            return res.status(400).json({ error: "Missing idToken or businessId" });
        }

        if (!isValidId(businessId)) {
            return res.status(400).json({ error: "Invalid business ID format" });
        }

        // 1. Verify with Firebase
        let decoded;
        try {
            decoded = await admin.auth().verifyIdToken(idToken);
        } catch (e) {
            console.error("verifyIdToken failed:", e.message);
            return res.status(401).json({ error: "Invalid Firebase ID token" });
        }

        let phone = decoded.phone_number;
        if (!phone) return res.status(400).json({ error: "Invalid phone number" });

        phone = toE164IL(phone);

        // 2. Find User in DB
        const user = await UserModel.findOne({ phone, business: businessId }).lean();
        if (!user) {
            return res.status(404).json({ error: "User not found for this business" });
        }

        // 3. Issue JWT
        const token = createToken(user._id, user.role, String(businessId));
        return res.json({ token, user });
    } catch (err) {
        console.error("Verify server error:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/**
 * POST /users/me/push-token
 * Updates the Expo Push Token for the current user
 */
router.post("/me/push-token", auth, async (req, res) => {
    try {
        const { expoPushToken } = req.body;

        if (!expoPushToken || typeof expoPushToken !== "string") {
            return res.status(400).json({ error: "expoPushToken is required" });
        }

        // 🛡️ Security: Update only for current user & business
        await UserModel.updateOne(
            { _id: req.tokenData._id, business: req.tokenData.business },
            { $set: { expoPushToken: expoPushToken.trim() } }
        );

        res.json({ ok: true });
    } catch (err) {
        console.error("Error updating push token:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/**
 * POST /users/me/test-push
 * Sends a self-test notification
 */
router.post("/me/test-push", auth, async (req, res) => {
    try {
        const user = await UserModel.findOne({
            _id: req.tokenData._id,
            business: req.tokenData.business,
        });

        if (!user || !user.expoPushToken) {
            return res.status(400).json({ error: "User not found or missing push token" });
        }

        const result = await sendPushToToken(
            user.expoPushToken,
            "Test Notification",
            "If you see this, the system works! ✅",
            { type: "test" }
        );

        if (result && result.ok === false) {
            return res.status(400).json({ error: "Push send failed", details: result.error });
        }

        res.json({ ok: true });
    } catch (err) {
        console.error("test-push error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/**
 * POST /users/admin/push
 * Admin Broadcast: Send push to all users in the business
 */
router.post("/admin/push", authAdmin, async (req, res) => {
    try {
        const { business } = req.tokenData;

        // Validate Input
        const { value, error } = pushSchema.validate(req.body, { abortEarly: false });
        if (error) {
            return res.status(400).json({
                error: "Invalid payload",
                details: error.details.map((d) => d.message),
            });
        }

        const { title, body, data } = value;

        // Fetch Tokens
        const users = await UserModel.find({
            business,
            expoPushToken: { $exists: true, $ne: null },
        }).select("expoPushToken");

        const tokens = [
            ...new Set(
                users
                    .map((u) => u.expoPushToken)
                    .filter((t) => typeof t === "string" && t.trim().length > 0)
                    .map((t) => t.trim())
            ),
        ];

        if (tokens.length === 0) {
            return res.status(400).json({ error: "No users with push tokens found" });
        }

        const campaignId = crypto.randomUUID();
        const payloadData = {
            ...(typeof data === "object" ? data : {}),
            type: "admin_broadcast",
            businessId: String(business),
            campaignId,
            createdAt: new Date().toISOString(),
        };

        // Send Broadcast
        const result = await sendPushToManyTokens(tokens, title, body, payloadData);

        // Cleanup Invalid Tokens
        if (result?.invalidTokens?.length) {
            await UserModel.updateMany(
                { business, expoPushToken: { $in: result.invalidTokens } },
                { $set: { expoPushToken: null } }
            );
        }

        // Save Notification History
        await NotificationModel.create({
            business,
            title,
            body,
            data: payloadData, // Save actual payload
            type: "admin_broadcast",
        });

        // Cleanup Old History (Keep last 5)
        const oldNotifications = await NotificationModel.find({ business })
            .sort({ createdAt: -1 })
            .skip(5)
            .select("_id");

        if (oldNotifications.length > 0) {
            await NotificationModel.deleteMany({
                _id: { $in: oldNotifications.map((doc) => doc._id) },
            });
        }

        res.json({
            ok: true,
            business,
            campaignId,
            requestedTokens: tokens.length,
            ...result,
        });
    } catch (err) {
        console.error("admin push error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/**
 * GET /users/admin/push-settings
 * Fetch admin notification preferences
 */
router.get("/admin/push-settings", authAdmin, async (req, res) => {
    try {
        const user = await UserModel.findOne({
            _id: req.tokenData._id,
            business: req.tokenData.business,
        })
            .select("adminPushSettings")
            .lean();

        if (!user) return res.status(404).json({ error: "User not found" });

        res.json({ adminPushSettings: user.adminPushSettings || {} });
    } catch (err) {
        console.error("get admin push-settings error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/**
 * PATCH /users/admin/push-settings
 * Update admin notification preferences
 */
router.patch("/admin/push-settings", authAdmin, async (req, res) => {
    try {
        const allowed = ["enabled", "onAppointmentCreated", "onAppointmentCanceled", "onUserSignup"];
        const updates = {};

        for (const key of allowed) {
            if (typeof req.body?.[key] === "boolean") {
                updates[`adminPushSettings.${key}`] = req.body[key];
            }
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: "No valid boolean fields to update" });
        }

        // 🛡️ Security: strict update by ID, Role, and Business
        const updateRes = await UserModel.updateOne(
            {
                _id: req.tokenData._id,
                role: "admin",
                business: req.tokenData.business,
            },
            { $set: updates }
        );

        if (updateRes.matchedCount === 0) {
            return res.status(403).json({ error: "Update failed (User not found or not admin)" });
        }

        // Fetch updated settings to return to client
        const user = await UserModel.findOne({
            _id: req.tokenData._id,
            business: req.tokenData.business,
        })
            .select("adminPushSettings")
            .lean();

        res.json({ ok: true, adminPushSettings: user?.adminPushSettings || {} });
    } catch (err) {
        console.error("patch admin push-settings error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

module.exports = router;